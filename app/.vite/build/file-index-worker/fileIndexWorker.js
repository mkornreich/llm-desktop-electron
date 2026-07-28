"use strict";
var __defProp = Object.defineProperty;
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
var __privateWrapper = (obj, member, setter, getter) => ({
  set _(value) {
    __privateSet(obj, member, value, setter);
  },
  get _() {
    return __privateGet(obj, member, getter);
  }
});
var _queue, _carryoverConcurrencyCount, _isIntervalIgnored, _intervalCount, _intervalCap, _interval, _intervalEnd, _intervalId, _timeoutId, _queue2, _queueClass, _pending, _concurrency, _isPaused, _throwOnTimeout, _PQueue_instances, doesIntervalAllowAnother_get, doesConcurrentAllowAnother_get, next_fn, onResumeInterval_fn, isIntervalPaused_get, tryToStartAnother_fn, initializeIntervalIfNeeded_fn, onInterval_fn, processQueue_fn, throwOnAbort_fn, onEvent_fn;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const path = require("node:path");
const node_child_process = require("node:child_process");
const node_string_decoder = require("node:string_decoder");
require("node:fs");
const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 6;
const BONUS_CONSECUTIVE = 4;
const BONUS_FIRST_CHAR = 8;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTENSION = 1;
const TOP_LEVEL_CACHE_LIMIT = 100;
const MAX_QUERY_LEN = 64;
const CHUNK_MS = 4;
const posBuf = new Int32Array(MAX_QUERY_LEN);
class FileIndex {
  constructor() {
    this.paths = [];
    this.lowerPaths = [];
    this.charBits = new Int32Array(0);
    this.pathLens = new Uint16Array(0);
    this.topLevelCache = null;
    this.readyCount = 0;
  }
  /**
   * True once the async build has indexed every path. Callers can use this
   * to skip fallback paths that only make sense while the index is partial.
   * Returns false for a freshly-constructed (empty) index so cold-start
   * fallbacks still fire before buildAsync() has populated anything.
   */
  get isFullyBuilt() {
    return this.paths.length > 0 && this.readyCount === this.paths.length;
  }
  /**
   * Load paths from an array of strings.
   * Automatically deduplicates and filters empty strings.
   */
  loadFromFileList(fileList) {
    const seen = /* @__PURE__ */ new Set();
    const paths = [];
    for (const line of fileList) {
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line);
        paths.push(line);
      }
    }
    this.buildIndex(paths);
  }
  /**
   * Async variant: yields to the event loop every few ms so large indexes
   * (270k+ files) don't block the main thread. Identical result to
   * loadFromFileList.
   *
   * Returns { queryable, done }:
   *   - queryable: resolves as soon as the first chunk is indexed (search
   *     returns partial results).
   *   - done: resolves when the entire index is built.
   */
  loadFromFileListAsync(fileList) {
    let markQueryable;
    const queryable = new Promise((resolve) => {
      markQueryable = resolve;
    });
    const done = this.buildAsync(fileList, markQueryable);
    return { queryable, done };
  }
  async buildAsync(fileList, markQueryable) {
    const seen = /* @__PURE__ */ new Set();
    const paths = [];
    let chunkStart = performance.now();
    for (let i = 0; i < fileList.length; i++) {
      const line = fileList[i];
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line);
        paths.push(line);
      }
      if ((i & 255) === 255 && performance.now() - chunkStart > CHUNK_MS) {
        await yieldToEventLoop();
        chunkStart = performance.now();
      }
    }
    this.resetArrays(paths);
    chunkStart = performance.now();
    let firstChunk = true;
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i);
      if ((i & 255) === 255 && performance.now() - chunkStart > CHUNK_MS) {
        this.readyCount = i + 1;
        if (firstChunk) {
          markQueryable();
          firstChunk = false;
        }
        await yieldToEventLoop();
        chunkStart = performance.now();
      }
    }
    this.readyCount = paths.length;
    markQueryable();
  }
  buildIndex(paths) {
    this.resetArrays(paths);
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i);
    }
    this.readyCount = paths.length;
  }
  resetArrays(paths) {
    const n = paths.length;
    this.paths = paths;
    this.lowerPaths = Array.from({ length: n }, () => "");
    this.charBits = new Int32Array(n);
    this.pathLens = new Uint16Array(n);
    this.readyCount = 0;
    this.topLevelCache = computeTopLevelEntries(paths, TOP_LEVEL_CACHE_LIMIT);
  }
  // Precompute: lowercase, a–z bitmap, length. Bitmap gives O(1) rejection
  // of paths missing any needle letter.
  indexPath(i) {
    const lp = this.paths[i].toLowerCase();
    this.lowerPaths[i] = lp;
    const len = lp.length;
    this.pathLens[i] = len;
    let bits = 0;
    for (let j = 0; j < len; j++) {
      const c = lp.charCodeAt(j);
      if (c >= 97 && c <= 122) {
        bits |= 1 << c - 97;
      }
    }
    this.charBits[i] = bits;
  }
  /**
   * Search for files matching the query using fuzzy matching.
   * Returns top N results sorted by match score.
   */
  search(query, limit) {
    if (limit <= 0) {
      return [];
    }
    if (query.length === 0) {
      if (this.topLevelCache) {
        return this.topLevelCache.slice(0, limit);
      }
      return [];
    }
    const caseSensitive = query !== query.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const nLen = Math.min(needle.length, MAX_QUERY_LEN);
    let needleBitmap = 0;
    const needleChars = Array.from({ length: nLen }, (_, j) => {
      const ch = needle.charAt(j);
      const cc = ch.charCodeAt(0);
      if (cc >= 97 && cc <= 122) {
        needleBitmap |= 1 << cc - 97;
      }
      return ch;
    });
    const scoreCeiling = nLen * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32;
    const topK = [];
    let threshold = -Infinity;
    const { paths, lowerPaths, charBits, pathLens, readyCount } = this;
    outer: for (let i = 0; i < readyCount; i++) {
      if ((charBits[i] & needleBitmap) !== needleBitmap) {
        continue;
      }
      const haystack = caseSensitive ? paths[i] : lowerPaths[i];
      let pos = haystack.indexOf(needleChars[0]);
      if (pos === -1) {
        continue;
      }
      posBuf[0] = pos;
      let gapPenalty = 0;
      let consecBonus = 0;
      let prev = pos;
      for (let j = 1; j < nLen; j++) {
        pos = haystack.indexOf(needleChars[j], prev + 1);
        if (pos === -1) {
          continue outer;
        }
        posBuf[j] = pos;
        const gap = pos - prev - 1;
        if (gap === 0) {
          consecBonus += BONUS_CONSECUTIVE;
        } else {
          gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION;
        }
        prev = pos;
      }
      if (topK.length === limit && scoreCeiling + consecBonus - gapPenalty <= threshold) {
        continue;
      }
      const path2 = paths[i];
      const hLen = pathLens[i];
      let score = nLen * SCORE_MATCH + consecBonus - gapPenalty;
      score += scoreBonusAt(path2, posBuf[0], true);
      for (let j = 1; j < nLen; j++) {
        score += scoreBonusAt(path2, posBuf[j], false);
      }
      score += Math.max(0, 32 - (hLen >> 2));
      if (topK.length < limit) {
        topK.push({
          path: path2,
          fuzzScore: score,
          positions: Array.from(posBuf.subarray(0, nLen))
        });
        if (topK.length === limit) {
          topK.sort((a, b) => a.fuzzScore - b.fuzzScore);
          threshold = topK[0].fuzzScore;
        }
      } else if (score > threshold) {
        let lo = 0;
        let hi = topK.length;
        while (lo < hi) {
          const mid = lo + hi >> 1;
          if (topK[mid].fuzzScore < score) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        topK.splice(lo, 0, {
          path: path2,
          fuzzScore: score,
          positions: Array.from(posBuf.subarray(0, nLen))
        });
        topK.shift();
        threshold = topK[0].fuzzScore;
      }
    }
    topK.sort((a, b) => b.fuzzScore - a.fuzzScore);
    const denom = Math.max(topK.length, 1);
    return topK.map(({ path: path2, positions }, i) => {
      const positionScore = i / denom;
      const finalScore = path2.includes("test") ? Math.min(positionScore * 1.05, 1) : positionScore;
      return { path: path2, score: finalScore, positions };
    });
  }
}
function scoreBonusAt(path2, pos, first) {
  if (pos === 0) {
    return first ? BONUS_FIRST_CHAR : 0;
  }
  const prevCh = path2.charCodeAt(pos - 1);
  if (isBoundary(prevCh)) {
    return BONUS_BOUNDARY;
  }
  if (isLower(prevCh) && isUpper(path2.charCodeAt(pos))) {
    return BONUS_CAMEL;
  }
  return 0;
}
function isBoundary(code) {
  return code === 47 || // /
  code === 92 || // \
  code === 45 || // -
  code === 95 || // _
  code === 46 || // .
  code === 32;
}
function isLower(code) {
  return code >= 97 && code <= 122;
}
function isUpper(code) {
  return code >= 65 && code <= 90;
}
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
function computeTopLevelEntries(paths, limit) {
  const topLevel = /* @__PURE__ */ new Set();
  for (const p of paths) {
    let end = p.length;
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (c === 47 || c === 92) {
        end = i;
        break;
      }
    }
    const segment = p.slice(0, end);
    if (segment.length > 0) {
      topLevel.add(segment);
      if (topLevel.size >= limit) {
        break;
      }
    }
  }
  const sorted = Array.from(topLevel);
  sorted.sort((a, b) => {
    const lenDiff = a.length - b.length;
    if (lenDiff !== 0) {
      return lenDiff;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return sorted.slice(0, limit).map((path2) => ({ path: path2, score: 0, positions: [] }));
}
class LRUCache {
  constructor(maxSize, onEvict) {
    this.cache = /* @__PURE__ */ new Map();
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }
  get(key) {
    const value = this.cache.get(key);
    if (value !== void 0) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }
  set(key, value) {
    var _a;
    this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > this.maxSize) {
      const oldest = this.cache.entries().next().value;
      if (oldest !== void 0) {
        this.cache.delete(oldest[0]);
        (_a = this.onEvict) == null ? void 0 : _a.call(this, oldest[0], oldest[1]);
      }
    }
  }
  delete(key) {
    var _a;
    const value = this.cache.get(key);
    const had = this.cache.delete(key);
    if (had && value !== void 0) {
      (_a = this.onEvict) == null ? void 0 : _a.call(this, key, value);
    }
    return had;
  }
  get size() {
    return this.cache.size;
  }
  clear() {
    if (this.onEvict) {
      for (const [k, v] of this.cache) {
        this.onEvict(k, v);
      }
    }
    this.cache.clear();
  }
}
function getDisclaimerBinaryPath() {
  {
    const contentsPath = path.dirname(process.resourcesPath);
    return path.join(contentsPath, "Helpers", "disclaimer");
  }
}
function getUntrustedLaunchOptions(options) {
  const disclaimerPath = getDisclaimerBinaryPath();
  return {
    cmd: disclaimerPath,
    args: [options.cmd, ...options.args]
  };
}
function abortRejection(signal, cmd) {
  return signal.reason instanceof Error ? signal.reason : new DOMException(`spawnAsync(${cmd}) aborted`, "AbortError");
}
async function spawnAsync(cmd, args = [], options = {}) {
  var _a;
  const untrusted = getUntrustedLaunchOptions({ cmd, args });
  try {
    return await spawnAsyncDirect(untrusted.cmd, untrusted.args, options);
  } catch (error) {
    if (((_a = options.signal) == null ? void 0 : _a.aborted) && (error === options.signal.reason || error instanceof Error && error.name === "AbortError")) {
      if (untrusted.cmd !== cmd && error !== options.signal.reason) {
        throw new DOMException(
          `spawnAsync(${cmd}) aborted (via disclaimer)`,
          "AbortError"
        );
      }
      throw error;
    }
    if (untrusted.cmd !== cmd && error instanceof Error) {
      const { code, spawnError } = error;
      const errnoProps = spawnError ? { code, spawnError } : {};
      const isEnoent = error.message.includes("ENOENT");
      if (isEnoent) {
        throw Object.assign(
          new Error(
            `Failed to spawn ${cmd} (disclaimer binary not found): ${error.message}`
          ),
          errnoProps
        );
      }
      throw Object.assign(
        new Error(`Failed to spawn ${cmd} (via disclaimer): ${error.message}`),
        errnoProps
      );
    }
    throw error;
  }
}
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const STREAMING_STDERR_TAIL_BYTES = 8192;
function spawnAsyncDirect(cmd, args = [], options = {}) {
  const {
    ignoreExitCode,
    maxBuffer = DEFAULT_MAX_BUFFER,
    stdin,
    destroyStdioOnExit,
    hardTimeoutMs,
    signal,
    onStdoutLine,
    ...spawnOptions
  } = options;
  if (signal == null ? void 0 : signal.aborted) {
    return Promise.reject(abortRejection(signal, cmd));
  }
  return new Promise((resolve, reject) => {
    var _a, _b;
    const proc = node_child_process.spawn(cmd, args, {
      ...spawnOptions,
      stdio: [stdin !== void 0 ? "pipe" : "ignore", "pipe", "pipe"]
    });
    if (stdin !== void 0 && proc.stdin) {
      proc.stdin.on("error", () => void 0);
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const stdout = [];
    const stderr = [];
    let totalBytes = 0;
    let killed = false;
    const withinMaxBuffer = (data) => {
      totalBytes += data.length;
      return totalBytes <= maxBuffer;
    };
    const onData = (chunks) => (data) => {
      if (!withinMaxBuffer(data)) {
        killed = true;
        proc.kill();
        return;
      }
      chunks.push(data);
    };
    const pgid = process.platform !== "win32" && spawnOptions.detached && typeof proc.pid === "number" ? proc.pid : void 0;
    const killGroup = (sig) => {
      if (pgid !== void 0) {
        try {
          process.kill(-pgid, sig);
          return;
        } catch {
        }
      }
      proc.kill(sig);
    };
    const killAndDestroyStdio = () => {
      var _a2, _b2;
      killGroup("SIGKILL");
      (_a2 = proc.stdout) == null ? void 0 : _a2.destroy();
      (_b2 = proc.stderr) == null ? void 0 : _b2.destroy();
    };
    let stoppedEarly = false;
    let lineHandlerError;
    const lineDecoder = onStdoutLine ? new node_string_decoder.StringDecoder("utf8") : void 0;
    let lineCarry = [];
    const emitLine = (line) => {
      try {
        if (onStdoutLine(line) === "stop") {
          stoppedEarly = true;
          killAndDestroyStdio();
          return false;
        }
        return true;
      } catch (error) {
        lineHandlerError = error instanceof Error ? error : new Error(String(error));
        killAndDestroyStdio();
        return false;
      }
    };
    const deliverLines = (decoded, flushCarry) => {
      if (stoppedEarly || lineHandlerError) {
        return;
      }
      let newlineAt = decoded.indexOf("\n");
      if (newlineAt === -1) {
        if (decoded.length > 0) {
          lineCarry.push(decoded);
        }
      } else {
        let lineStart = 0;
        do {
          const tail = decoded.slice(lineStart, newlineAt);
          const assembled = lineCarry.length === 0 ? tail : lineCarry.join("") + tail;
          const line = assembled.endsWith("\r") ? assembled.slice(0, -1) : assembled;
          lineCarry = [];
          lineStart = newlineAt + 1;
          if (!emitLine(line)) {
            return;
          }
          newlineAt = decoded.indexOf("\n", lineStart);
        } while (newlineAt !== -1);
        if (lineStart < decoded.length) {
          lineCarry.push(decoded.slice(lineStart));
        }
      }
      if (flushCarry && lineCarry.length > 0) {
        const trailing = lineCarry.join("");
        lineCarry = [];
        emitLine(trailing);
      }
    };
    const streamOverflowStop = (data) => {
      if (withinMaxBuffer(data)) {
        return false;
      }
      stoppedEarly = true;
      killAndDestroyStdio();
      return true;
    };
    (_a = proc.stdout) == null ? void 0 : _a.on(
      "data",
      lineDecoder ? (data) => {
        if (streamOverflowStop(data)) {
          return;
        }
        deliverLines(lineDecoder.write(data), false);
      } : onData(stdout)
    );
    let stderrRetained = 0;
    (_b = proc.stderr) == null ? void 0 : _b.on(
      "data",
      lineDecoder ? (data) => {
        if (streamOverflowStop(data)) {
          return;
        }
        stderr.push(data);
        stderrRetained += data.length;
        while (stderr.length > 1 && stderrRetained - stderr[0].length >= STREAMING_STDERR_TAIL_BYTES) {
          stderrRetained -= stderr.shift().length;
        }
      } : onData(stderr)
    );
    let aborted = false;
    const onAbort = () => {
      const childExited = proc.exitCode !== null || proc.signalCode !== null;
      if (!childExited) {
        aborted = true;
        proc.kill(spawnOptions.killSignal);
      }
      if (pgid !== void 0) {
        killGroup("SIGTERM");
      }
      setTimeout(() => {
        var _a2, _b2;
        killGroup("SIGKILL");
        if (!childExited) {
          (_a2 = proc.stdout) == null ? void 0 : _a2.destroy();
          (_b2 = proc.stderr) == null ? void 0 : _b2.destroy();
        }
      }, 1e3).unref();
    };
    signal == null ? void 0 : signal.addEventListener("abort", onAbort, { once: true });
    let hardTimer;
    let hardKilled = false;
    if (hardTimeoutMs) {
      hardTimer = setTimeout(() => {
        hardKilled = true;
        killAndDestroyStdio();
      }, hardTimeoutMs);
    }
    proc.on("error", (error) => {
      if (hardTimer) {
        clearTimeout(hardTimer);
      }
      signal == null ? void 0 : signal.removeEventListener("abort", onAbort);
      reject(
        Object.assign(new Error(`Failed to spawn ${cmd}: ${error.message}`), {
          code: error.code,
          spawnError: true
        })
      );
    });
    let exitGraceTimer;
    proc.on("exit", () => {
      if (proc.killed && pgid !== void 0) {
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 1e3).unref();
      }
      if (!proc.killed && !destroyStdioOnExit) {
        return;
      }
      exitGraceTimer = setTimeout(() => {
        var _a2, _b2;
        (_a2 = proc.stdout) == null ? void 0 : _a2.destroy();
        (_b2 = proc.stderr) == null ? void 0 : _b2.destroy();
      }, 1e3);
    });
    proc.on("close", (code) => {
      if (exitGraceTimer) {
        clearTimeout(exitGraceTimer);
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
      }
      signal == null ? void 0 : signal.removeEventListener("abort", onAbort);
      if (aborted && signal) {
        reject(abortRejection(signal, cmd));
        return;
      }
      if (lineHandlerError) {
        reject(lineHandlerError);
        return;
      }
      if (killed) {
        reject(
          Object.assign(
            new Error(
              `${cmd} output exceeded maxBuffer limit (${maxBuffer} bytes)`
            ),
            { code: "EMAXBUFFER" }
          )
        );
        return;
      }
      if (lineDecoder) {
        deliverLines(lineDecoder.end(), true);
        if (lineHandlerError) {
          reject(lineHandlerError);
          return;
        }
      }
      const stderrBuffer = Buffer.concat(stderr);
      const stderrStr = stderrBuffer.toString();
      const stdoutBuffer = Buffer.concat(stdout);
      const result = {
        stdout: stdoutBuffer.toString(),
        stdoutBuffer,
        stderrBuffer,
        stderr: hardKilled ? `${stderrStr}${stderrStr ? "\n" : ""}killed after ${hardTimeoutMs}ms hard deadline` : stderrStr,
        code,
        stoppedEarly
      };
      if (!ignoreExitCode && code !== 0 && !stoppedEarly) {
        const error = new Error(
          `${cmd} exited with code ${code}: ${result.stderr || result.stdout}`
        );
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}
function getDefaultExportFromCjs(x) {
  return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var eventemitter3 = { exports: {} };
var hasRequiredEventemitter3;
function requireEventemitter3() {
  if (hasRequiredEventemitter3) return eventemitter3.exports;
  hasRequiredEventemitter3 = 1;
  (function(module2) {
    var has = Object.prototype.hasOwnProperty, prefix = "~";
    function Events() {
    }
    if (Object.create) {
      Events.prototype = /* @__PURE__ */ Object.create(null);
      if (!new Events().__proto__) prefix = false;
    }
    function EE(fn, context, once) {
      this.fn = fn;
      this.context = context;
      this.once = once || false;
    }
    function addListener(emitter, event, fn, context, once) {
      if (typeof fn !== "function") {
        throw new TypeError("The listener must be a function");
      }
      var listener = new EE(fn, context || emitter, once), evt = prefix ? prefix + event : event;
      if (!emitter._events[evt]) emitter._events[evt] = listener, emitter._eventsCount++;
      else if (!emitter._events[evt].fn) emitter._events[evt].push(listener);
      else emitter._events[evt] = [emitter._events[evt], listener];
      return emitter;
    }
    function clearEvent(emitter, evt) {
      if (--emitter._eventsCount === 0) emitter._events = new Events();
      else delete emitter._events[evt];
    }
    function EventEmitter2() {
      this._events = new Events();
      this._eventsCount = 0;
    }
    EventEmitter2.prototype.eventNames = function eventNames() {
      var names = [], events, name;
      if (this._eventsCount === 0) return names;
      for (name in events = this._events) {
        if (has.call(events, name)) names.push(prefix ? name.slice(1) : name);
      }
      if (Object.getOwnPropertySymbols) {
        return names.concat(Object.getOwnPropertySymbols(events));
      }
      return names;
    };
    EventEmitter2.prototype.listeners = function listeners(event) {
      var evt = prefix ? prefix + event : event, handlers = this._events[evt];
      if (!handlers) return [];
      if (handlers.fn) return [handlers.fn];
      for (var i = 0, l = handlers.length, ee = new Array(l); i < l; i++) {
        ee[i] = handlers[i].fn;
      }
      return ee;
    };
    EventEmitter2.prototype.listenerCount = function listenerCount(event) {
      var evt = prefix ? prefix + event : event, listeners = this._events[evt];
      if (!listeners) return 0;
      if (listeners.fn) return 1;
      return listeners.length;
    };
    EventEmitter2.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt]) return false;
      var listeners = this._events[evt], len = arguments.length, args, i;
      if (listeners.fn) {
        if (listeners.once) this.removeListener(event, listeners.fn, void 0, true);
        switch (len) {
          case 1:
            return listeners.fn.call(listeners.context), true;
          case 2:
            return listeners.fn.call(listeners.context, a1), true;
          case 3:
            return listeners.fn.call(listeners.context, a1, a2), true;
          case 4:
            return listeners.fn.call(listeners.context, a1, a2, a3), true;
          case 5:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
          case 6:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
        }
        for (i = 1, args = new Array(len - 1); i < len; i++) {
          args[i - 1] = arguments[i];
        }
        listeners.fn.apply(listeners.context, args);
      } else {
        var length = listeners.length, j;
        for (i = 0; i < length; i++) {
          if (listeners[i].once) this.removeListener(event, listeners[i].fn, void 0, true);
          switch (len) {
            case 1:
              listeners[i].fn.call(listeners[i].context);
              break;
            case 2:
              listeners[i].fn.call(listeners[i].context, a1);
              break;
            case 3:
              listeners[i].fn.call(listeners[i].context, a1, a2);
              break;
            case 4:
              listeners[i].fn.call(listeners[i].context, a1, a2, a3);
              break;
            default:
              if (!args) for (j = 1, args = new Array(len - 1); j < len; j++) {
                args[j - 1] = arguments[j];
              }
              listeners[i].fn.apply(listeners[i].context, args);
          }
        }
      }
      return true;
    };
    EventEmitter2.prototype.on = function on(event, fn, context) {
      return addListener(this, event, fn, context, false);
    };
    EventEmitter2.prototype.once = function once(event, fn, context) {
      return addListener(this, event, fn, context, true);
    };
    EventEmitter2.prototype.removeListener = function removeListener(event, fn, context, once) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt]) return this;
      if (!fn) {
        clearEvent(this, evt);
        return this;
      }
      var listeners = this._events[evt];
      if (listeners.fn) {
        if (listeners.fn === fn && (!once || listeners.once) && (!context || listeners.context === context)) {
          clearEvent(this, evt);
        }
      } else {
        for (var i = 0, events = [], length = listeners.length; i < length; i++) {
          if (listeners[i].fn !== fn || once && !listeners[i].once || context && listeners[i].context !== context) {
            events.push(listeners[i]);
          }
        }
        if (events.length) this._events[evt] = events.length === 1 ? events[0] : events;
        else clearEvent(this, evt);
      }
      return this;
    };
    EventEmitter2.prototype.removeAllListeners = function removeAllListeners(event) {
      var evt;
      if (event) {
        evt = prefix ? prefix + event : event;
        if (this._events[evt]) clearEvent(this, evt);
      } else {
        this._events = new Events();
        this._eventsCount = 0;
      }
      return this;
    };
    EventEmitter2.prototype.off = EventEmitter2.prototype.removeListener;
    EventEmitter2.prototype.addListener = EventEmitter2.prototype.on;
    EventEmitter2.prefixed = prefix;
    EventEmitter2.EventEmitter = EventEmitter2;
    {
      module2.exports = EventEmitter2;
    }
  })(eventemitter3);
  return eventemitter3.exports;
}
var eventemitter3Exports = requireEventemitter3();
const EventEmitter = /* @__PURE__ */ getDefaultExportFromCjs(eventemitter3Exports);
class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}
class AbortError extends Error {
  constructor(message) {
    super();
    this.name = "AbortError";
    this.message = message;
  }
}
const getDOMException = (errorMessage) => globalThis.DOMException === void 0 ? new AbortError(errorMessage) : new DOMException(errorMessage);
const getAbortedReason = (signal) => {
  const reason = signal.reason === void 0 ? getDOMException("This operation was aborted.") : signal.reason;
  return reason instanceof Error ? reason : getDOMException(reason);
};
function pTimeout(promise, options) {
  const {
    milliseconds,
    fallback,
    message,
    customTimers = { setTimeout, clearTimeout }
  } = options;
  let timer;
  let abortHandler;
  const wrappedPromise = new Promise((resolve, reject) => {
    if (typeof milliseconds !== "number" || Math.sign(milliseconds) !== 1) {
      throw new TypeError(`Expected \`milliseconds\` to be a positive number, got \`${milliseconds}\``);
    }
    if (options.signal) {
      const { signal } = options;
      if (signal.aborted) {
        reject(getAbortedReason(signal));
      }
      abortHandler = () => {
        reject(getAbortedReason(signal));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    if (milliseconds === Number.POSITIVE_INFINITY) {
      promise.then(resolve, reject);
      return;
    }
    const timeoutError = new TimeoutError();
    timer = customTimers.setTimeout.call(void 0, () => {
      if (fallback) {
        try {
          resolve(fallback());
        } catch (error) {
          reject(error);
        }
        return;
      }
      if (typeof promise.cancel === "function") {
        promise.cancel();
      }
      if (message === false) {
        resolve();
      } else if (message instanceof Error) {
        reject(message);
      } else {
        timeoutError.message = message ?? `Promise timed out after ${milliseconds} milliseconds`;
        reject(timeoutError);
      }
    }, milliseconds);
    (async () => {
      try {
        resolve(await promise);
      } catch (error) {
        reject(error);
      }
    })();
  });
  const cancelablePromise = wrappedPromise.finally(() => {
    cancelablePromise.clear();
    if (abortHandler && options.signal) {
      options.signal.removeEventListener("abort", abortHandler);
    }
  });
  cancelablePromise.clear = () => {
    customTimers.clearTimeout.call(void 0, timer);
    timer = void 0;
  };
  return cancelablePromise;
}
function lowerBound(array, value, comparator) {
  let first = 0;
  let count = array.length;
  while (count > 0) {
    const step = Math.trunc(count / 2);
    let it = first + step;
    if (comparator(array[it], value) <= 0) {
      first = ++it;
      count -= step + 1;
    } else {
      count = step;
    }
  }
  return first;
}
class PriorityQueue {
  constructor() {
    __privateAdd(this, _queue, []);
  }
  enqueue(run, options) {
    options = {
      priority: 0,
      ...options
    };
    const element = {
      priority: options.priority,
      run
    };
    if (this.size && __privateGet(this, _queue)[this.size - 1].priority >= options.priority) {
      __privateGet(this, _queue).push(element);
      return;
    }
    const index = lowerBound(__privateGet(this, _queue), element, (a, b) => b.priority - a.priority);
    __privateGet(this, _queue).splice(index, 0, element);
  }
  dequeue() {
    const item = __privateGet(this, _queue).shift();
    return item == null ? void 0 : item.run;
  }
  filter(options) {
    return __privateGet(this, _queue).filter((element) => element.priority === options.priority).map((element) => element.run);
  }
  get size() {
    return __privateGet(this, _queue).length;
  }
}
_queue = new WeakMap();
class PQueue extends EventEmitter {
  // TODO: The `throwOnTimeout` option should affect the return types of `add()` and `addAll()`
  constructor(options) {
    var _a, _b;
    super();
    __privateAdd(this, _PQueue_instances);
    __privateAdd(this, _carryoverConcurrencyCount);
    __privateAdd(this, _isIntervalIgnored);
    __privateAdd(this, _intervalCount, 0);
    __privateAdd(this, _intervalCap);
    __privateAdd(this, _interval);
    __privateAdd(this, _intervalEnd, 0);
    __privateAdd(this, _intervalId);
    __privateAdd(this, _timeoutId);
    __privateAdd(this, _queue2);
    __privateAdd(this, _queueClass);
    __privateAdd(this, _pending, 0);
    // The `!` is needed because of https://github.com/microsoft/TypeScript/issues/32194
    __privateAdd(this, _concurrency);
    __privateAdd(this, _isPaused);
    __privateAdd(this, _throwOnTimeout);
    /**
        Per-operation timeout in milliseconds. Operations fulfill once `timeout` elapses if they haven't already.
    
        Applies to each future operation.
        */
    __publicField(this, "timeout");
    options = {
      carryoverConcurrencyCount: false,
      intervalCap: Number.POSITIVE_INFINITY,
      interval: 0,
      concurrency: Number.POSITIVE_INFINITY,
      autoStart: true,
      queueClass: PriorityQueue,
      ...options
    };
    if (!(typeof options.intervalCap === "number" && options.intervalCap >= 1)) {
      throw new TypeError(`Expected \`intervalCap\` to be a number from 1 and up, got \`${((_a = options.intervalCap) == null ? void 0 : _a.toString()) ?? ""}\` (${typeof options.intervalCap})`);
    }
    if (options.interval === void 0 || !(Number.isFinite(options.interval) && options.interval >= 0)) {
      throw new TypeError(`Expected \`interval\` to be a finite number >= 0, got \`${((_b = options.interval) == null ? void 0 : _b.toString()) ?? ""}\` (${typeof options.interval})`);
    }
    __privateSet(this, _carryoverConcurrencyCount, options.carryoverConcurrencyCount);
    __privateSet(this, _isIntervalIgnored, options.intervalCap === Number.POSITIVE_INFINITY || options.interval === 0);
    __privateSet(this, _intervalCap, options.intervalCap);
    __privateSet(this, _interval, options.interval);
    __privateSet(this, _queue2, new options.queueClass());
    __privateSet(this, _queueClass, options.queueClass);
    this.concurrency = options.concurrency;
    this.timeout = options.timeout;
    __privateSet(this, _throwOnTimeout, options.throwOnTimeout === true);
    __privateSet(this, _isPaused, options.autoStart === false);
  }
  get concurrency() {
    return __privateGet(this, _concurrency);
  }
  set concurrency(newConcurrency) {
    if (!(typeof newConcurrency === "number" && newConcurrency >= 1)) {
      throw new TypeError(`Expected \`concurrency\` to be a number from 1 and up, got \`${newConcurrency}\` (${typeof newConcurrency})`);
    }
    __privateSet(this, _concurrency, newConcurrency);
    __privateMethod(this, _PQueue_instances, processQueue_fn).call(this);
  }
  async add(function_, options = {}) {
    options = {
      timeout: this.timeout,
      throwOnTimeout: __privateGet(this, _throwOnTimeout),
      ...options
    };
    return new Promise((resolve, reject) => {
      __privateGet(this, _queue2).enqueue(async () => {
        var _a;
        __privateWrapper(this, _pending)._++;
        __privateWrapper(this, _intervalCount)._++;
        try {
          (_a = options.signal) == null ? void 0 : _a.throwIfAborted();
          let operation = function_({ signal: options.signal });
          if (options.timeout) {
            operation = pTimeout(Promise.resolve(operation), { milliseconds: options.timeout });
          }
          if (options.signal) {
            operation = Promise.race([operation, __privateMethod(this, _PQueue_instances, throwOnAbort_fn).call(this, options.signal)]);
          }
          const result = await operation;
          resolve(result);
          this.emit("completed", result);
        } catch (error) {
          if (error instanceof TimeoutError && !options.throwOnTimeout) {
            resolve();
            return;
          }
          reject(error);
          this.emit("error", error);
        } finally {
          __privateMethod(this, _PQueue_instances, next_fn).call(this);
        }
      }, options);
      this.emit("add");
      __privateMethod(this, _PQueue_instances, tryToStartAnother_fn).call(this);
    });
  }
  async addAll(functions, options) {
    return Promise.all(functions.map(async (function_) => this.add(function_, options)));
  }
  /**
  Start (or resume) executing enqueued tasks within concurrency limit. No need to call this if queue is not paused (via `options.autoStart = false` or by `.pause()` method.)
  */
  start() {
    if (!__privateGet(this, _isPaused)) {
      return this;
    }
    __privateSet(this, _isPaused, false);
    __privateMethod(this, _PQueue_instances, processQueue_fn).call(this);
    return this;
  }
  /**
  Put queue execution on hold.
  */
  pause() {
    __privateSet(this, _isPaused, true);
  }
  /**
  Clear the queue.
  */
  clear() {
    __privateSet(this, _queue2, new (__privateGet(this, _queueClass))());
  }
  /**
      Can be called multiple times. Useful if you for example add additional items at a later time.
  
      @returns A promise that settles when the queue becomes empty.
      */
  async onEmpty() {
    if (__privateGet(this, _queue2).size === 0) {
      return;
    }
    await __privateMethod(this, _PQueue_instances, onEvent_fn).call(this, "empty");
  }
  /**
      @returns A promise that settles when the queue size is less than the given limit: `queue.size < limit`.
  
      If you want to avoid having the queue grow beyond a certain size you can `await queue.onSizeLessThan()` before adding a new item.
  
      Note that this only limits the number of items waiting to start. There could still be up to `concurrency` jobs already running that this call does not include in its calculation.
      */
  async onSizeLessThan(limit) {
    if (__privateGet(this, _queue2).size < limit) {
      return;
    }
    await __privateMethod(this, _PQueue_instances, onEvent_fn).call(this, "next", () => __privateGet(this, _queue2).size < limit);
  }
  /**
      The difference with `.onEmpty` is that `.onIdle` guarantees that all work from the queue has finished. `.onEmpty` merely signals that the queue is empty, but it could mean that some promises haven't completed yet.
  
      @returns A promise that settles when the queue becomes empty, and all promises have completed; `queue.size === 0 && queue.pending === 0`.
      */
  async onIdle() {
    if (__privateGet(this, _pending) === 0 && __privateGet(this, _queue2).size === 0) {
      return;
    }
    await __privateMethod(this, _PQueue_instances, onEvent_fn).call(this, "idle");
  }
  /**
  Size of the queue, the number of queued items waiting to run.
  */
  get size() {
    return __privateGet(this, _queue2).size;
  }
  /**
      Size of the queue, filtered by the given options.
  
      For example, this can be used to find the number of items remaining in the queue with a specific priority level.
      */
  sizeBy(options) {
    return __privateGet(this, _queue2).filter(options).length;
  }
  /**
  Number of running items (no longer in the queue).
  */
  get pending() {
    return __privateGet(this, _pending);
  }
  /**
  Whether the queue is currently paused.
  */
  get isPaused() {
    return __privateGet(this, _isPaused);
  }
}
_carryoverConcurrencyCount = new WeakMap();
_isIntervalIgnored = new WeakMap();
_intervalCount = new WeakMap();
_intervalCap = new WeakMap();
_interval = new WeakMap();
_intervalEnd = new WeakMap();
_intervalId = new WeakMap();
_timeoutId = new WeakMap();
_queue2 = new WeakMap();
_queueClass = new WeakMap();
_pending = new WeakMap();
_concurrency = new WeakMap();
_isPaused = new WeakMap();
_throwOnTimeout = new WeakMap();
_PQueue_instances = new WeakSet();
doesIntervalAllowAnother_get = function() {
  return __privateGet(this, _isIntervalIgnored) || __privateGet(this, _intervalCount) < __privateGet(this, _intervalCap);
};
doesConcurrentAllowAnother_get = function() {
  return __privateGet(this, _pending) < __privateGet(this, _concurrency);
};
next_fn = function() {
  __privateWrapper(this, _pending)._--;
  __privateMethod(this, _PQueue_instances, tryToStartAnother_fn).call(this);
  this.emit("next");
};
onResumeInterval_fn = function() {
  __privateMethod(this, _PQueue_instances, onInterval_fn).call(this);
  __privateMethod(this, _PQueue_instances, initializeIntervalIfNeeded_fn).call(this);
  __privateSet(this, _timeoutId, void 0);
};
isIntervalPaused_get = function() {
  const now = Date.now();
  if (__privateGet(this, _intervalId) === void 0) {
    const delay = __privateGet(this, _intervalEnd) - now;
    if (delay < 0) {
      __privateSet(this, _intervalCount, __privateGet(this, _carryoverConcurrencyCount) ? __privateGet(this, _pending) : 0);
    } else {
      if (__privateGet(this, _timeoutId) === void 0) {
        __privateSet(this, _timeoutId, setTimeout(() => {
          __privateMethod(this, _PQueue_instances, onResumeInterval_fn).call(this);
        }, delay));
      }
      return true;
    }
  }
  return false;
};
tryToStartAnother_fn = function() {
  if (__privateGet(this, _queue2).size === 0) {
    if (__privateGet(this, _intervalId)) {
      clearInterval(__privateGet(this, _intervalId));
    }
    __privateSet(this, _intervalId, void 0);
    this.emit("empty");
    if (__privateGet(this, _pending) === 0) {
      this.emit("idle");
    }
    return false;
  }
  if (!__privateGet(this, _isPaused)) {
    const canInitializeInterval = !__privateGet(this, _PQueue_instances, isIntervalPaused_get);
    if (__privateGet(this, _PQueue_instances, doesIntervalAllowAnother_get) && __privateGet(this, _PQueue_instances, doesConcurrentAllowAnother_get)) {
      const job = __privateGet(this, _queue2).dequeue();
      if (!job) {
        return false;
      }
      this.emit("active");
      job();
      if (canInitializeInterval) {
        __privateMethod(this, _PQueue_instances, initializeIntervalIfNeeded_fn).call(this);
      }
      return true;
    }
  }
  return false;
};
initializeIntervalIfNeeded_fn = function() {
  if (__privateGet(this, _isIntervalIgnored) || __privateGet(this, _intervalId) !== void 0) {
    return;
  }
  __privateSet(this, _intervalId, setInterval(() => {
    __privateMethod(this, _PQueue_instances, onInterval_fn).call(this);
  }, __privateGet(this, _interval)));
  __privateSet(this, _intervalEnd, Date.now() + __privateGet(this, _interval));
};
onInterval_fn = function() {
  if (__privateGet(this, _intervalCount) === 0 && __privateGet(this, _pending) === 0 && __privateGet(this, _intervalId)) {
    clearInterval(__privateGet(this, _intervalId));
    __privateSet(this, _intervalId, void 0);
  }
  __privateSet(this, _intervalCount, __privateGet(this, _carryoverConcurrencyCount) ? __privateGet(this, _pending) : 0);
  __privateMethod(this, _PQueue_instances, processQueue_fn).call(this);
};
/**
Executes all queued functions until it reaches the limit.
*/
processQueue_fn = function() {
  while (__privateMethod(this, _PQueue_instances, tryToStartAnother_fn).call(this)) {
  }
};
throwOnAbort_fn = async function(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason);
    }, { once: true });
  });
};
onEvent_fn = async function(event, filter) {
  return new Promise((resolve) => {
    const listener = () => {
      if (filter && !filter()) {
        return;
      }
      this.off(event, listener);
      resolve();
    };
    this.on(event, listener);
  });
};
const GIT_UTF8_PATHS = ["-c", "core.quotepath=false"];
const GIT_NO_FSMONITOR = ["-c", "core.fsmonitor=false"];
const GIT_NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
const UNTRUSTED_CWD_GIT_CONFIG_ARGS = [
  ...GIT_NO_FSMONITOR,
  ...GIT_NO_HOOKS
];
const GIT_LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;
const CHILD_REPO_SCAN_CONCURRENCY = 4;
async function listFilesWithGit(cwd) {
  try {
    const result = await spawnAsync(
      "git",
      [
        ...UNTRUSTED_CWD_GIT_CONFIG_ARGS,
        ...GIT_UTF8_PATHS,
        "ls-files",
        "--recurse-submodules"
      ],
      {
        cwd,
        timeout: 1e4,
        // Backstop for a child the soft timeout can't kill (trapped SIGTERM,
        // uninterruptible I/O on a dead network mount). Without it the spawn
        // promise can orphan and main's coalesced refresh never settles.
        hardTimeoutMs: 15e3,
        maxBuffer: GIT_LS_FILES_MAX_BUFFER,
        // Resolve (rather than reject) on non-zero exit so real failures —
        // repo corruption, permission errors, timeout kills — reach the warn
        // below instead of the quiet catch.
        ignoreExitCode: true
      }
    );
    if (result.code !== 0) {
      if (!result.stderr.includes("not a git repository")) {
        console.warn(
          "git ls-files failed; falling back to shallow BFS (deep paths may be missing in @-mention autocomplete):",
          result.stderr
        );
      }
      return null;
    }
    return result.stdout;
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeded maxBuffer")) {
      console.warn(
        "git ls-files output exceeded the size cap; falling back to shallow BFS (deep paths may be missing in @-mention autocomplete):",
        error.message
      );
    }
    return null;
  }
}
async function listGitRepos(repos) {
  const scanQueue = new PQueue({ concurrency: CHILD_REPO_SCAN_CONCURRENCY });
  const perRepo = await Promise.all(
    repos.map(({ dir }) => scanQueue.add(() => listFilesWithGit(dir)))
  );
  const listings = [];
  repos.forEach(({ prefix }, i) => {
    const stdout = perRepo[i];
    if (typeof stdout === "string") {
      listings.push({ prefix, stdout });
    } else if (prefix.length > 0) {
      listings.push({ prefix, stdout: "" });
    }
  });
  return listings;
}
const SKIP_DIRECTORIES = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  ".tox",
  ".venv",
  "venv",
  "env",
  ".env",
  "coverage",
  ".nyc_output",
  ".turbo",
  ".parcel-cache",
  "target",
  // Rust/Java build output
  "vendor",
  // Go/PHP dependencies
  // Tool caches/metadata previously masked by the blanket startsWith(".")
  // filter. Without these, a single .terraform/ or .yarn/ in a non-git
  // cwd can saturate the BFS budget before it reaches user source.
  ".terraform",
  ".gradle",
  ".m2",
  ".mvn",
  ".idea",
  ".vscode",
  ".history",
  ".yarn",
  ".pnpm-store",
  ".npm",
  ".vite"
]);
const CONTENT_SEARCH_TIMEOUT_MS = 8e3;
const CONTENT_SEARCH_PREVIEW_MAX = 200;
const PER_FILE_MATCH_CAP = 5;
const RG_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
function isRgMatchEvent(v) {
  return typeof v === "object" && v !== null && v.type === "match";
}
function makeMatchCollector(cap, cwd) {
  const out = [];
  const perFile = /* @__PURE__ */ new Map();
  return {
    out,
    add: (match) => {
      if (path.relative(cwd, match.absPath).startsWith("..")) {
        return;
      }
      const fileCount = perFile.get(match.relativePath) ?? 0;
      if (fileCount >= PER_FILE_MATCH_CAP) {
        return;
      }
      perFile.set(match.relativePath, fileCount + 1);
      out.push(match);
      if (out.length >= cap) {
        return "stop";
      }
    }
  };
}
function searchSpawnOptions(cwd, pathEnv, onStdoutLine, maxBuffer) {
  return {
    cwd,
    timeout: CONTENT_SEARCH_TIMEOUT_MS,
    // The soft timeout's SIGTERM can't kill a child stuck in uninterruptible
    // I/O (SMB/NFS, CloudStorage placeholders); hardTimeoutMs SIGKILLs so a
    // search can't hang the picker. detached puts the disclaimed child in
    // its own process group so that SIGKILL reaches it (proc.kill only hits
    // the disclaimer wrapper); Windows has no process-group kill.
    hardTimeoutMs: CONTENT_SEARCH_TIMEOUT_MS + 2e3,
    detached: true,
    // Both children exit non-zero on "no matches" — a result, not a failure.
    ignoreExitCode: true,
    onStdoutLine,
    maxBuffer,
    // Dock-launched apps inherit launchd's minimal PATH (no Homebrew); main
    // resolves the same augmented PATH runGit uses and hands it over.
    env: { ...process.env, PATH: pathEnv }
  };
}
async function searchContentInDirectory(query, cwd, cap, pathEnv) {
  const rgResults = await searchWithRipgrep(query, cwd, cap, pathEnv);
  if (rgResults !== null) {
    return rgResults;
  }
  return searchWithGitGrep(query, cwd, cap, pathEnv);
}
async function searchWithRipgrep(query, cwd, cap, pathEnv) {
  const { out, add } = makeMatchCollector(cap, cwd);
  let sawStdout = false;
  const onStdoutLine = (line) => {
    var _a;
    sawStdout = true;
    if (line.length === 0) {
      return;
    }
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRgMatchEvent(evt)) {
      return;
    }
    const relativePath = evt.data.path.text;
    if (!relativePath) {
      return;
    }
    const previewRaw = evt.data.lines.text ?? "";
    return add({
      relativePath: relativePath.replaceAll("\\", "/"),
      absPath: path.join(cwd, relativePath),
      line: evt.data.line_number,
      column: (((_a = evt.data.submatches[0]) == null ? void 0 : _a.start) ?? 0) + 1,
      preview: previewRaw.replace(/\r?\n$/, "").slice(0, CONTENT_SEARCH_PREVIEW_MAX)
    });
  };
  let result;
  try {
    result = await spawnAsync(
      "rg",
      [
        "--json",
        // Ignore ~/.ripgreprc so results are deterministic across machines.
        "--no-config",
        "-S",
        "--fixed-strings",
        "--max-count",
        String(PER_FILE_MATCH_CAP),
        "--max-columns",
        String(CONTENT_SEARCH_PREVIEW_MAX),
        "--max-columns-preview",
        "-g",
        "!node_modules",
        "--",
        query
      ],
      searchSpawnOptions(cwd, pathEnv, onStdoutLine, RG_MAX_OUTPUT_BYTES)
    );
  } catch (err) {
    console.warn("contentSearch: rg spawn failed; falling back", err);
    return null;
  }
  if (result.stoppedEarly && out.length === 0 || !result.stoppedEarly && result.code !== 0 && !(result.code === null && out.length > 0) && !(result.code === 1 && sawStdout) && !(result.code === 2 && out.length > 0)) {
    console.warn(
      "contentSearch: rg nonzero; falling back",
      result.code,
      result.stderr
    );
    return null;
  }
  return out;
}
function gitVersionSupportsGrepMaxCount(versionOutput) {
  const match = /git version (\d+)\.(\d+)/.exec(versionOutput);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || major === 2 && minor >= 38;
}
const GIT_VERSION_PROBE_TIMEOUT_MS = 2e3;
let grepMaxCountSupport;
function probeGitGrepMaxCountSupport(pathEnv) {
  grepMaxCountSupport ?? (grepMaxCountSupport = spawnAsync(
    "git",
    [...UNTRUSTED_CWD_GIT_CONFIG_ARGS, "--version"],
    {
      timeout: GIT_VERSION_PROBE_TIMEOUT_MS,
      hardTimeoutMs: GIT_VERSION_PROBE_TIMEOUT_MS * 2,
      detached: true,
      env: { ...process.env, PATH: pathEnv }
    }
  ).then((result) => gitVersionSupportsGrepMaxCount(result.stdout)).catch(() => {
    grepMaxCountSupport = void 0;
    return false;
  }));
  return grepMaxCountSupport;
}
async function searchWithGitGrep(query, cwd, cap, pathEnv) {
  const { out, add } = makeMatchCollector(cap, cwd);
  const onStdoutLine = (raw) => {
    if (raw.length === 0) {
      return;
    }
    const nul1 = raw.indexOf("\0");
    const nul2 = raw.indexOf("\0", nul1 + 1);
    if (nul1 < 0 || nul2 < 0) {
      return;
    }
    const relativePath = raw.slice(0, nul1);
    const lineNo = Number.parseInt(raw.slice(nul1 + 1, nul2), 10);
    if (!Number.isFinite(lineNo)) {
      return;
    }
    return add({
      relativePath: relativePath.replaceAll("\\", "/"),
      absPath: path.join(cwd, relativePath),
      line: lineNo,
      column: 1,
      preview: raw.slice(nul2 + 1).slice(0, CONTENT_SEARCH_PREVIEW_MAX)
    });
  };
  try {
    const args = [
      ...UNTRUSTED_CWD_GIT_CONFIG_ARGS,
      "grep",
      "--no-index",
      "--exclude-standard",
      "-nIz",
      "--fixed-strings"
    ];
    if (await probeGitGrepMaxCountSupport(pathEnv)) {
      args.push("-m", String(PER_FILE_MATCH_CAP));
    }
    if (query === query.toLowerCase()) {
      args.push("-i");
    }
    args.push("-e", query, "--");
    for (const d of SKIP_DIRECTORIES) {
      args.push(`:(exclude,glob)**/${d}/**`);
    }
    args.push(":(exclude,glob)**/.*", ":(exclude,glob)**/.*/**");
    await spawnAsync(
      "git",
      args,
      searchSpawnOptions(cwd, pathEnv, onStdoutLine)
    );
  } catch (err) {
    console.warn("contentSearch: git grep spawn failed", err);
    return [];
  }
  return out;
}
const MAX_STAGED_GIT_LISTINGS = 2;
class FileIndexHost {
  constructor() {
    this.entries = [];
    this.pathToFile = /* @__PURE__ */ new Map();
    this.index = null;
    this.stagedGitListings = new LRUCache(MAX_STAGED_GIT_LISTINGS);
  }
  /**
   * Drop the index (focused cwd changed). Staged git listings survive on
   * purpose: when the new focus resolves to the same cwd (landing page →
   * session in that folder) the in-flight refresh must still be able to
   * commit its warm listing — main re-checks the target before every
   * commit, so a genuinely stale stage is never committed.
   */
  clear() {
    this.entries = [];
    this.pathToFile = /* @__PURE__ */ new Map();
    this.index = null;
  }
  /** Replace the file list with pre-parsed entries (SSH / BFS listings). */
  setEntries(files) {
    this.commit(files);
  }
  /** `git ls-files` each repo and hold the raw output here, keyed by the
   *  service-minted stageToken, until main commits it — the index is
   *  untouched. False = the sole (prefix "") repo isn't a git repo, so the
   *  caller should fall back. */
  async stageGitListing(cwd, repos, stageToken) {
    const listings = await listGitRepos(repos);
    if (listings.length === 0) {
      return false;
    }
    this.stagedGitListings.set(stageToken, { cwd, listings });
    return true;
  }
  /** Free a staged listing whose refresh isn't going to commit it. */
  discardStagedGitListing(stageToken) {
    this.stagedGitListings.delete(stageToken);
  }
  /** Atomically replace the index with a staged listing. False when the
   *  stage is gone (worker reforked, or evicted past the cap) — the caller
   *  treats it like any other failed ship. */
  commitStagedGitListing(stageToken) {
    const staged = this.stagedGitListings.get(stageToken);
    this.stagedGitListings.delete(stageToken);
    if (!staged) {
      return false;
    }
    this.commitGitListing(staged.cwd, staged.listings);
    return true;
  }
  /** Replace the file list from raw `git ls-files` stdout(s): files + derived
   *  parent-directory entries (parents first, deduped), each repo namespaced
   *  under its prefix. */
  commitGitListing(cwd, repos) {
    const seen = /* @__PURE__ */ new Set();
    const files = [];
    const push = (name, relativePath, isDirectory) => {
      seen.add(relativePath);
      files.push({
        name,
        relativePath,
        fullPath: path.join(cwd, relativePath),
        isDirectory
      });
    };
    for (const { prefix, stdout } of repos) {
      if (prefix.length > 0 && !seen.has(prefix)) {
        push(prefix, prefix, true);
      }
      for (const line of stdout.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        const relativePath = prefix.length > 0 ? `${prefix}/${line}` : line;
        const parts = relativePath.split("/");
        for (let i = 1; i < parts.length; i++) {
          const dirPath = parts.slice(0, i).join("/");
          if (!seen.has(dirPath)) {
            push(parts[i - 1], dirPath, true);
          }
        }
        if (!seen.has(relativePath)) {
          push(parts[parts.length - 1], relativePath, false);
        }
      }
    }
    this.commit(files);
  }
  /** Bounded snapshot of the current file list (listProjectFiles IPC). */
  list(limit) {
    return this.entries.slice(0, limit);
  }
  /** Fuzzy-rank over the full file list. */
  search(query, limit) {
    const matches = [];
    if (this.index) {
      for (const { path: relativePath, positions } of this.index.search(
        query,
        limit
      )) {
        const file = this.pathToFile.get(relativePath);
        if (file) {
          matches.push({ ...file, positions: Array.from(positions) });
        }
      }
    }
    return matches;
  }
  commit(files) {
    const pathToFile = /* @__PURE__ */ new Map();
    const relativePaths = files.map((f) => {
      pathToFile.set(f.relativePath, f);
      return f.relativePath;
    });
    try {
      const index = new FileIndex();
      index.loadFromFileList(relativePaths);
      this.entries = files;
      this.pathToFile = pathToFile;
      this.index = index;
    } catch (error) {
      console.error("[file-index] FileIndex build failed:", error);
      this.clear();
    }
  }
}
if (process.parentPort !== void 0) {
  process.parentPort.once("message", (e) => {
    var _a;
    if (e.data.type !== "init" || !((_a = e.ports) == null ? void 0 : _a[0])) {
      process.exit(1);
    }
    const host = new FileIndexHost();
    const port = e.ports[0];
    const post = (message) => {
      try {
        port.postMessage(message);
      } catch {
      }
    };
    const postSettled = (requestId, pending) => {
      void pending.then((body) => post({ ...body, requestId })).catch(
        (error) => post({
          type: "error",
          requestId,
          message: error instanceof Error ? error.message : "Unknown error"
        })
      );
    };
    const handle = (request) => {
      switch (request.type) {
        case "clear":
          return host.clear();
        case "discard-staged-git":
          return host.discardStagedGitListing(request.stageToken);
        case "set-entries":
          host.setEntries(request.files);
          return post({ type: "set-result", requestId: request.requestId });
        case "stage-git-listing":
          return postSettled(
            request.requestId,
            host.stageGitListing(request.cwd, request.repos, request.stageToken).then((staged) => ({
              type: "stage-git-result",
              staged
            }))
          );
        case "commit-staged-git":
          return post({
            type: "commit-staged-result",
            requestId: request.requestId,
            committed: host.commitStagedGitListing(request.stageToken)
          });
        case "search":
          return post({
            type: "search-result",
            requestId: request.requestId,
            results: host.search(request.query, request.limit)
          });
        case "content-search":
          return postSettled(
            request.requestId,
            searchContentInDirectory(
              request.query,
              request.cwd,
              request.cap,
              request.pathEnv
            ).then((results) => ({
              type: "content-search-result",
              results
            }))
          );
        case "list":
          return post({
            type: "list-result",
            requestId: request.requestId,
            files: host.list(request.limit)
          });
        default:
          return request;
      }
    };
    port.on("message", (event) => {
      const request = event.data;
      try {
        handle(request);
      } catch (error) {
        if ("requestId" in request) {
          post({
            type: "error",
            requestId: request.requestId,
            message: error instanceof Error ? error.message : "Unknown error"
          });
        }
      }
    });
    port.start();
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}
exports.FileIndexHost = FileIndexHost;
