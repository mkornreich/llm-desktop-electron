"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require$$0$2 = require("fs");
const require$$1 = require("path");
const require$$3 = require("crypto");
const fs$2 = require("fs/promises");
const heavyWorkWorker = require("./heavyWorkWorker-BoosRz18.js");
const require$$0 = require("constants");
const require$$5 = require("stream");
const require$$0$1 = require("util");
const require$$2 = require("assert");
const require$$0$3 = require("tty");
const require$$1$1 = require("os");
const require$$1$2 = require("child_process");
var util$1;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util$1 || (util$1 = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
const ZodParsedType = util$1.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
const getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};
const ZodIssueCode = util$1.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
class ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util$1.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
}
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};
const errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util$1.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util$1.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util$1.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util$1.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util$1.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util$1.assertNever(issue);
  }
  return { message };
};
let overrideErrorMap = errorMap;
function getErrorMap() {
  return overrideErrorMap;
}
const makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === errorMap ? void 0 : errorMap
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
class ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
}
const INVALID = Object.freeze({
  status: "aborted"
});
const DIRTY = (value) => ({ status: "dirty", value });
const OK = (value) => ({ status: "valid", value });
const isAborted = (x) => x.status === "aborted";
const isDirty = (x) => x.status === "dirty";
const isValid = (x) => x.status === "valid";
const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message == null ? void 0 : message.message;
})(errorUtil || (errorUtil = {}));
class ParseInputLazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
}
const handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
class ZodType {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: (params == null ? void 0 : params.async) ?? false,
        contextualErrorMap: params == null ? void 0 : params.errorMap
      },
      path: (params == null ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    var _a, _b;
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if ((_b = (_a = err == null ? void 0 : err.message) == null ? void 0 : _a.toLowerCase()) == null ? void 0 : _b.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params == null ? void 0 : params.errorMap,
        async: true
      },
      path: (params == null ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
}
const cuidRegex = /^c[^\s-]{8,}$/i;
const cuid2Regex = /^[0-9a-z]+$/;
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const nanoidRegex = /^[a-z0-9_-]{21}$/i;
const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
const _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
let emojiRegex;
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
const ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
const base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
const dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && (decoded == null ? void 0 : decoded.typ) !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
class ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util$1.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof (options == null ? void 0 : options.precision) === "undefined" ? null : options == null ? void 0 : options.precision,
      offset: (options == null ? void 0 : options.offset) ?? false,
      local: (options == null ? void 0 : options.local) ?? false,
      ...errorUtil.errToObj(options == null ? void 0 : options.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof (options == null ? void 0 : options.precision) === "undefined" ? null : options == null ? void 0 : options.precision,
      ...errorUtil.errToObj(options == null ? void 0 : options.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options == null ? void 0 : options.position,
      ...errorUtil.errToObj(options == null ? void 0 : options.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: (params == null ? void 0 : params.coerce) ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
class ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util$1.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util$1.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util$1.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
}
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: (params == null ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
class ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util$1.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: (params == null ? void 0 : params.coerce) ?? false,
    ...processCreateParams(params)
  });
};
class ZodBoolean extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: (params == null ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
class ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util$1.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
}
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: (params == null ? void 0 : params.coerce) || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
class ZodSymbol extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
class ZodUndefined extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
class ZodNull extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
class ZodAny extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
class ZodUnknown extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
class ZodNever extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
}
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
class ZodVoid extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
class ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
class ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util$1.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") ;
      else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          var _a, _b;
          const defaultError = ((_b = (_a = this._def).errorMap) == null ? void 0 : _b.call(_a, issue, ctx).message) ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util$1.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util$1.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util$1.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util$1.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util$1.objectKeys(this.shape));
  }
}
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
class ZodUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
}
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util$1.objectKeys(b);
    const sharedKeys = util$1.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
class ZodIntersection extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
}
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
class ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple({
      ...this._def,
      rest
    });
  }
}
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
class ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
}
class ZodMap extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
}
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
class ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
class ZodLazy extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
}
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
class ZodLiteral extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
}
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
class ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util$1.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
}
ZodEnum.create = createZodEnum;
class ZodNativeEnum extends ZodType {
  _parse(input) {
    const nativeEnumValues = util$1.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util$1.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util$1.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util$1.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util$1.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
}
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
class ZodPromise extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
}
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
class ZodEffects extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util$1.assertNever(effect);
  }
}
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
class ZodOptional extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
class ZodNullable extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
class ZodDefault extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
}
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
class ZodCatch extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
}
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
class ZodNaN extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
}
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
class ZodBranded extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
}
class ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
}
class ZodReadonly extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
const stringType = ZodString.create;
const numberType = ZodNumber.create;
const booleanType = ZodBoolean.create;
const anyType = ZodAny.create;
ZodNever.create;
const arrayType = ZodArray.create;
const objectType = ZodObject.create;
const strictObjectType = ZodObject.strictCreate;
const unionType = ZodUnion.create;
ZodIntersection.create;
ZodTuple.create;
const recordType = ZodRecord.create;
const literalType = ZodLiteral.create;
const enumType = ZodEnum.create;
ZodPromise.create;
ZodOptional.create;
ZodNullable.create;
const MANIFEST_VERSION$7 = "0.1";
const McpServerConfigSchema$7 = strictObjectType({
  command: stringType(),
  args: arrayType(stringType()).optional(),
  env: recordType(stringType(), stringType()).optional()
});
const McpbManifestAuthorSchema$7 = strictObjectType({
  name: stringType(),
  email: stringType().email().optional(),
  url: stringType().url().optional()
});
const McpbManifestRepositorySchema$7 = strictObjectType({
  type: stringType(),
  url: stringType().url()
});
const McpbManifestPlatformOverrideSchema$7 = McpServerConfigSchema$7.partial();
const McpbManifestMcpConfigSchema$7 = McpServerConfigSchema$7.extend({
  platform_overrides: recordType(stringType(), McpbManifestPlatformOverrideSchema$7).optional()
});
const McpbManifestServerSchema$7 = strictObjectType({
  type: enumType(["python", "node", "binary"]),
  entry_point: stringType(),
  mcp_config: McpbManifestMcpConfigSchema$7
});
const McpbManifestCompatibilitySchema$7 = strictObjectType({
  claude_desktop: stringType().optional(),
  platforms: arrayType(enumType(["darwin", "win32", "linux"])).optional(),
  runtimes: strictObjectType({
    python: stringType().optional(),
    node: stringType().optional()
  }).optional()
});
const McpbManifestToolSchema$7 = strictObjectType({
  name: stringType(),
  description: stringType().optional()
});
const McpbManifestPromptSchema$7 = strictObjectType({
  name: stringType(),
  description: stringType().optional(),
  arguments: arrayType(stringType()).optional(),
  text: stringType()
});
const McpbUserConfigurationOptionSchema$7 = strictObjectType({
  type: enumType(["string", "number", "boolean", "directory", "file"]),
  title: stringType(),
  description: stringType(),
  required: booleanType().optional(),
  default: unionType([stringType(), numberType(), booleanType(), arrayType(stringType())]).optional(),
  multiple: booleanType().optional(),
  sensitive: booleanType().optional(),
  min: numberType().optional(),
  max: numberType().optional()
});
const McpbManifestSchema$3 = strictObjectType({
  $schema: stringType().optional(),
  dxt_version: literalType(MANIFEST_VERSION$7).optional().describe("@deprecated Use manifest_version instead"),
  manifest_version: literalType(MANIFEST_VERSION$7).optional(),
  name: stringType(),
  display_name: stringType().optional(),
  version: stringType(),
  description: stringType(),
  long_description: stringType().optional(),
  author: McpbManifestAuthorSchema$7,
  repository: McpbManifestRepositorySchema$7.optional(),
  homepage: stringType().url().optional(),
  documentation: stringType().url().optional(),
  support: stringType().url().optional(),
  icon: stringType().optional(),
  screenshots: arrayType(stringType()).optional(),
  server: McpbManifestServerSchema$7,
  tools: arrayType(McpbManifestToolSchema$7).optional(),
  tools_generated: booleanType().optional(),
  prompts: arrayType(McpbManifestPromptSchema$7).optional(),
  prompts_generated: booleanType().optional(),
  keywords: arrayType(stringType()).optional(),
  license: stringType().optional(),
  compatibility: McpbManifestCompatibilitySchema$7.optional(),
  user_config: recordType(stringType(), McpbUserConfigurationOptionSchema$7).optional()
}).refine((data) => !!(data.dxt_version || data.manifest_version), {
  message: "Either 'dxt_version' (deprecated) or 'manifest_version' must be provided"
});
const MANIFEST_VERSION$6 = "0.2";
const McpServerConfigSchema$6 = strictObjectType({
  command: stringType(),
  args: arrayType(stringType()).optional(),
  env: recordType(stringType(), stringType()).optional()
});
const McpbManifestAuthorSchema$6 = strictObjectType({
  name: stringType(),
  email: stringType().email().optional(),
  url: stringType().url().optional()
});
const McpbManifestRepositorySchema$6 = strictObjectType({
  type: stringType(),
  url: stringType().url()
});
const McpbManifestPlatformOverrideSchema$6 = McpServerConfigSchema$6.partial();
const McpbManifestMcpConfigSchema$6 = McpServerConfigSchema$6.extend({
  platform_overrides: recordType(stringType(), McpbManifestPlatformOverrideSchema$6).optional()
});
const McpbManifestServerSchema$6 = strictObjectType({
  type: enumType(["python", "node", "binary"]),
  entry_point: stringType(),
  mcp_config: McpbManifestMcpConfigSchema$6
});
const McpbManifestCompatibilitySchema$6 = strictObjectType({
  claude_desktop: stringType().optional(),
  platforms: arrayType(enumType(["darwin", "win32", "linux"])).optional(),
  runtimes: strictObjectType({
    python: stringType().optional(),
    node: stringType().optional()
  }).optional()
});
const McpbManifestToolSchema$6 = strictObjectType({
  name: stringType(),
  description: stringType().optional()
});
const McpbManifestPromptSchema$6 = strictObjectType({
  name: stringType(),
  description: stringType().optional(),
  arguments: arrayType(stringType()).optional(),
  text: stringType()
});
const McpbUserConfigurationOptionSchema$6 = strictObjectType({
  type: enumType(["string", "number", "boolean", "directory", "file"]),
  title: stringType(),
  description: stringType(),
  required: booleanType().optional(),
  default: unionType([stringType(), numberType(), booleanType(), arrayType(stringType())]).optional(),
  multiple: booleanType().optional(),
  sensitive: booleanType().optional(),
  min: numberType().optional(),
  max: numberType().optional()
});
const McpbManifestSchema$2 = strictObjectType({
  $schema: stringType().optional(),
  dxt_version: literalType(MANIFEST_VERSION$6).optional().describe("@deprecated Use manifest_version instead"),
  manifest_version: literalType(MANIFEST_VERSION$6).optional(),
  name: stringType(),
  display_name: stringType().optional(),
  version: stringType(),
  description: stringType(),
  long_description: stringType().optional(),
  author: McpbManifestAuthorSchema$6,
  repository: McpbManifestRepositorySchema$6.optional(),
  homepage: stringType().url().optional(),
  documentation: stringType().url().optional(),
  support: stringType().url().optional(),
  icon: stringType().optional(),
  screenshots: arrayType(stringType()).optional(),
  server: McpbManifestServerSchema$6,
  tools: arrayType(McpbManifestToolSchema$6).optional(),
  tools_generated: booleanType().optional(),
  prompts: arrayType(McpbManifestPromptSchema$6).optional(),
  prompts_generated: booleanType().optional(),
  keywords: arrayType(stringType()).optional(),
  license: stringType().optional(),
  privacy_policies: arrayType(stringType().url()).optional(),
  compatibility: McpbManifestCompatibilitySchema$6.optional(),
  user_config: recordType(stringType(), McpbUserConfigurationOptionSchema$6).optional()
}).refine((data) => !!(data.dxt_version || data.manifest_version), {
  message: "Either 'dxt_version' (deprecated) or 'manifest_version' must be provided"
});
const MANIFEST_VERSION$5 = "0.3";
const LOCALE_PLACEHOLDER_REGEX$3 = /\$\{locale\}/i;
const BCP47_REGEX$3 = /^[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const ICON_SIZE_REGEX$3 = /^\d+x\d+$/;
const McpServerConfigSchema$5 = strictObjectType({
  command: stringType(),
  args: arrayType(stringType()).optional(),
  env: recordType(stringType(), stringType()).optional()
});
const McpbManifestAuthorSchema$5 = strictObjectType({
  name: stringType(),
  email: stringType().email().optional(),
  url: stringType().url().optional()
});
const McpbManifestRepositorySchema$5 = strictObjectType({
  type: stringType(),
  url: stringType().url()
});
const McpbManifestPlatformOverrideSchema$5 = McpServerConfigSchema$5.partial();
const McpbManifestMcpConfigSchema$5 = McpServerConfigSchema$5.extend({
  platform_overrides: recordType(stringType(), McpbManifestPlatformOverrideSchema$5).optional()
});
const McpbManifestServerSchema$5 = strictObjectType({
  type: enumType(["python", "node", "binary"]),
  entry_point: stringType(),
  mcp_config: McpbManifestMcpConfigSchema$5
});
const McpbManifestCompatibilitySchema$5 = strictObjectType({
  claude_desktop: stringType().optional(),
  platforms: arrayType(enumType(["darwin", "win32", "linux"])).optional(),
  runtimes: strictObjectType({
    python: stringType().optional(),
    node: stringType().optional()
  }).optional()
});
const McpbManifestToolSchema$5 = strictObjectType({
  name: stringType(),
  description: stringType().optional()
});
const McpbManifestPromptSchema$5 = strictObjectType({
  name: stringType(),
  description: stringType().optional(),
  arguments: arrayType(stringType()).optional(),
  text: stringType()
});
const McpbUserConfigurationOptionSchema$5 = strictObjectType({
  type: enumType(["string", "number", "boolean", "directory", "file"]),
  title: stringType(),
  description: stringType(),
  required: booleanType().optional(),
  default: unionType([stringType(), numberType(), booleanType(), arrayType(stringType())]).optional(),
  multiple: booleanType().optional(),
  sensitive: booleanType().optional(),
  min: numberType().optional(),
  max: numberType().optional()
});
const McpbManifestLocalizationSchema$3 = strictObjectType({
  resources: stringType().regex(LOCALE_PLACEHOLDER_REGEX$3, 'resources must include a "${locale}" placeholder'),
  default_locale: stringType().regex(BCP47_REGEX$3, "default_locale must be a valid BCP 47 locale identifier")
});
const McpbManifestIconSchema$3 = strictObjectType({
  src: stringType(),
  size: stringType().regex(ICON_SIZE_REGEX$3, 'size must be in the format "WIDTHxHEIGHT" (e.g., "16x16")'),
  theme: stringType().min(1, "theme cannot be empty when provided").optional()
});
const McpbManifestSchema$1 = strictObjectType({
  $schema: stringType().optional(),
  dxt_version: literalType(MANIFEST_VERSION$5).optional().describe("@deprecated Use manifest_version instead"),
  manifest_version: literalType(MANIFEST_VERSION$5).optional(),
  name: stringType(),
  display_name: stringType().optional(),
  version: stringType(),
  description: stringType(),
  long_description: stringType().optional(),
  author: McpbManifestAuthorSchema$5,
  repository: McpbManifestRepositorySchema$5.optional(),
  homepage: stringType().url().optional(),
  documentation: stringType().url().optional(),
  support: stringType().url().optional(),
  icon: stringType().optional(),
  icons: arrayType(McpbManifestIconSchema$3).optional(),
  screenshots: arrayType(stringType()).optional(),
  localization: McpbManifestLocalizationSchema$3.optional(),
  server: McpbManifestServerSchema$5,
  tools: arrayType(McpbManifestToolSchema$5).optional(),
  tools_generated: booleanType().optional(),
  prompts: arrayType(McpbManifestPromptSchema$5).optional(),
  prompts_generated: booleanType().optional(),
  keywords: arrayType(stringType()).optional(),
  license: stringType().optional(),
  privacy_policies: arrayType(stringType().url()).optional(),
  compatibility: McpbManifestCompatibilitySchema$5.optional(),
  user_config: recordType(stringType(), McpbUserConfigurationOptionSchema$5).optional(),
  _meta: recordType(stringType(), recordType(stringType(), anyType())).optional()
}).refine((data) => !!(data.dxt_version || data.manifest_version), {
  message: "Either 'dxt_version' (deprecated) or 'manifest_version' must be provided"
});
const MANIFEST_VERSION$4 = "0.4";
const LOCALE_PLACEHOLDER_REGEX$2 = /\$\{locale\}/i;
const BCP47_REGEX$2 = /^[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const ICON_SIZE_REGEX$2 = /^\d+x\d+$/;
const McpServerConfigSchema$4 = strictObjectType({
  command: stringType(),
  args: arrayType(stringType()).optional(),
  env: recordType(stringType(), stringType()).optional()
});
const McpbManifestAuthorSchema$4 = strictObjectType({
  name: stringType(),
  email: stringType().email().optional(),
  url: stringType().url().optional()
});
const McpbManifestRepositorySchema$4 = strictObjectType({
  type: stringType(),
  url: stringType().url()
});
const McpbManifestPlatformOverrideSchema$4 = McpServerConfigSchema$4.partial();
const McpbManifestMcpConfigSchema$4 = McpServerConfigSchema$4.extend({
  platform_overrides: recordType(stringType(), McpbManifestPlatformOverrideSchema$4).optional()
});
const McpbManifestServerSchema$4 = strictObjectType({
  type: enumType(["python", "node", "binary", "uv"]),
  entry_point: stringType(),
  mcp_config: McpbManifestMcpConfigSchema$4
});
const McpbManifestCompatibilitySchema$4 = strictObjectType({
  claude_desktop: stringType().optional(),
  platforms: arrayType(enumType(["darwin", "win32", "linux"])).optional(),
  runtimes: strictObjectType({
    python: stringType().optional(),
    node: stringType().optional()
  }).optional()
});
const McpbManifestToolSchema$4 = strictObjectType({
  name: stringType(),
  description: stringType().optional()
});
const McpbManifestPromptSchema$4 = strictObjectType({
  name: stringType(),
  description: stringType().optional(),
  arguments: arrayType(stringType()).optional(),
  text: stringType()
});
const McpbUserConfigurationOptionSchema$4 = strictObjectType({
  type: enumType(["string", "number", "boolean", "directory", "file"]),
  title: stringType(),
  description: stringType(),
  required: booleanType().optional(),
  default: unionType([stringType(), numberType(), booleanType(), arrayType(stringType())]).optional(),
  multiple: booleanType().optional(),
  sensitive: booleanType().optional(),
  min: numberType().optional(),
  max: numberType().optional()
});
const McpbManifestLocalizationSchema$2 = strictObjectType({
  resources: stringType().regex(LOCALE_PLACEHOLDER_REGEX$2, 'resources must include a "${locale}" placeholder'),
  default_locale: stringType().regex(BCP47_REGEX$2, "default_locale must be a valid BCP 47 locale identifier")
});
const McpbManifestIconSchema$2 = strictObjectType({
  src: stringType(),
  size: stringType().regex(ICON_SIZE_REGEX$2, 'size must be in the format "WIDTHxHEIGHT" (e.g., "16x16")'),
  theme: stringType().min(1, "theme cannot be empty when provided").optional()
});
const McpbManifestSchema = strictObjectType({
  $schema: stringType().optional(),
  dxt_version: literalType(MANIFEST_VERSION$4).optional().describe("@deprecated Use manifest_version instead"),
  manifest_version: literalType(MANIFEST_VERSION$4).optional(),
  name: stringType(),
  display_name: stringType().optional(),
  version: stringType(),
  description: stringType(),
  long_description: stringType().optional(),
  author: McpbManifestAuthorSchema$4,
  repository: McpbManifestRepositorySchema$4.optional(),
  homepage: stringType().url().optional(),
  documentation: stringType().url().optional(),
  support: stringType().url().optional(),
  icon: stringType().optional(),
  icons: arrayType(McpbManifestIconSchema$2).optional(),
  screenshots: arrayType(stringType()).optional(),
  localization: McpbManifestLocalizationSchema$2.optional(),
  server: McpbManifestServerSchema$4,
  tools: arrayType(McpbManifestToolSchema$4).optional(),
  tools_generated: booleanType().optional(),
  prompts: arrayType(McpbManifestPromptSchema$4).optional(),
  prompts_generated: booleanType().optional(),
  keywords: arrayType(stringType()).optional(),
  license: stringType().optional(),
  privacy_policies: arrayType(stringType().url()).optional(),
  compatibility: McpbManifestCompatibilitySchema$4.optional(),
  user_config: recordType(stringType(), McpbUserConfigurationOptionSchema$4).optional(),
  _meta: recordType(stringType(), recordType(stringType(), anyType())).optional()
}).refine((data) => !!(data.dxt_version || data.manifest_version), {
  message: "Either 'dxt_version' (deprecated) or 'manifest_version' must be provided"
});
const MANIFEST_VERSION$3 = "0.1";
const McpServerConfigSchema$3 = objectType({
  command: stringType(),
  args: arrayType(stringType()).optional(),
  env: recordType(stringType(), stringType()).optional()
});
const McpbManifestAuthorSchema$3 = objectType({
  name: stringType(),
  email: stringType().email().optional(),
  url: stringType().url().optional()
});
const McpbManifestRepositorySchema$3 = objectType({
  type: stringType(),
  url: stringType().url()
});
const McpbManifestPlatformOverrideSchema$3 = McpServerConfigSchema$3.partial();
const McpbManifestMcpConfigSchema$3 = McpServerConfigSchema$3.extend({
  platform_overrides: recordType(stringType(), McpbManifestPlatformOverrideSchema$3).optional()
});
const McpbManifestServerSchema$3 = objectType({
  type: enumType(["python", "node", "binary"]),
  entry_point: stringType(),
  mcp_config: McpbManifestMcpConfigSchema$3
});
const McpbManifestCompatibilitySchema$3 = objectType({
  claude_desktop: stringType().optional(),
  platforms: arrayType(enumType(["darwin", "win32", "linux"])).optional(),
  runtimes: objectType({
    python: stringType().optional(),
    node: stringType().optional()
  }).optional()
}).passthrough();
const McpbManifestToolSchema$3 = objectType({
  name: stringType(),
  description: stringType().optional()
});
const McpbManifestPromptSchema$3 = objectType({
  name: stringType(),
  description: stringType().optional(),
  arguments: arrayType(stringType()).optional(),
  text: stringType()
});
const McpbUserConfigurationOptionSchema$3 = objectType({
  type: enumType(["string", "number", "boolean", "directory", "file"]),
  title: stringType(),
  description: stringType(),
  required: booleanType().optional(),
  default: unionType([stringType(), numberType(), booleanType(), arrayType(stringType())]).optional(),
  multiple: booleanType().optional(),
  sensitive: booleanType().optional(),
  min: numberType().optional(),
  max: numberType().optional()
});
objectType({
  $schema: stringType().optional(),
  dxt_version: literalType(MANIFEST_VERSION$3).optional().describe("@deprecated Use manifest_version instead"),
  manifest_version: literalType(MANIFEST_VERSION$3).optional(),
  name: stringType(),
  display_name: stringType().optional(),
  version: stringType(),
  description: stringType(),
  long_description: stringType().optional(),
  author: McpbManifestAuthorSchema$3,
  repository: McpbManifestRepositorySchema$3.optional(),
  homepage: stringType().url().optional(),
  documentation: stringType().url().optional(),
  support: stringType().url().optional(),
  icon: stringType().optional(),
  screenshots: arrayType(stringType()).optional(),
  server: McpbManifestServerSchema$3,
  tools: arrayType(McpbManifestToolSchema$3).optional(),
  tools_generated: booleanType().optional(),
  prompts: arrayType(McpbManifestPromptSchema$3).optional(),
  prompts_generated: booleanType().optional(),
  keywords: arrayType(stringType()).optional(),
  license: stringType().optional(),
  compatibility: McpbManifestCompatibilitySchema$3.optional(),
  user_config: recordType(stringType(), McpbUserConfigurationOptionSchema$3).optional()
}).refine((data) => !!(data.dxt_version || data.manifest_version), {
  message: "Either 'dxt_version' (deprecated) or 'manifest_version' must be provided"
});
const MANIFEST_VERSION$2 = "0.2";
const McpServerConfigSchema$2 = objectType({
  command: stringType(),
  args: arrayType(stringType()).optional(),
  env: recordType(stringType(), stringType()).optional()
});
const McpbManifestAuthorSchema$2 = objectType({
  name: stringType(),
  email: stringType().email().optional(),
  url: stringType().url().optional()
});
const McpbManifestRepositorySchema$2 = objectType({
  type: stringType(),
  url: stringType().url()
});
const McpbManifestPlatformOverrideSchema$2 = McpServerConfigSchema$2.partial();
const McpbManifestMcpConfigSchema$2 = McpServerConfigSchema$2.extend({
  platform_overrides: recordType(stringType(), McpbManifestPlatformOverrideSchema$2).optional()
});
const McpbManifestServerSchema$2 = objectType({
  type: enumType(["python", "node", "binary"]),
  entry_point: stringType(),
  mcp_config: McpbManifestMcpConfigSchema$2
});
const McpbManifestCompatibilitySchema$2 = objectType({
  claude_desktop: stringType().optional(),
  platforms: arrayType(enumType(["darwin", "win32", "linux"])).optional(),
  runtimes: objectType({
    python: stringType().optional(),
    node: stringType().optional()
  }).optional()
}).passthrough();
const McpbManifestToolSchema$2 = objectType({
  name: stringType(),
  description: stringType().optional()
});
const McpbManifestPromptSchema$2 = objectType({
  name: stringType(),
  description: stringType().optional(),
  arguments: arrayType(stringType()).optional(),
  text: stringType()
});
const McpbUserConfigurationOptionSchema$2 = objectType({
  type: enumType(["string", "number", "boolean", "directory", "file"]),
  title: stringType(),
  description: stringType(),
  required: booleanType().optional(),
  default: unionType([stringType(), numberType(), booleanType(), arrayType(stringType())]).optional(),
  multiple: booleanType().optional(),
  sensitive: booleanType().optional(),
  min: numberType().optional(),
  max: numberType().optional()
});
objectType({
  $schema: stringType().optional(),
  dxt_version: literalType(MANIFEST_VERSION$2).optional().describe("@deprecated Use manifest_version instead"),
  manifest_version: literalType(MANIFEST_VERSION$2).optional(),
  name: stringType(),
  display_name: stringType().optional(),
  version: stringType(),
  description: stringType(),
  long_description: stringType().optional(),
  author: McpbManifestAuthorSchema$2,
  repository: McpbManifestRepositorySchema$2.optional(),
  homepage: stringType().url().optional(),
  documentation: stringType().url().optional(),
  support: stringType().url().optional(),
  icon: stringType().optional(),
  screenshots: arrayType(stringType()).optional(),
  server: McpbManifestServerSchema$2,
  tools: arrayType(McpbManifestToolSchema$2).optional(),
  tools_generated: booleanType().optional(),
  prompts: arrayType(McpbManifestPromptSchema$2).optional(),
  prompts_generated: booleanType().optional(),
  keywords: arrayType(stringType()).optional(),
  license: stringType().optional(),
  privacy_policies: arrayType(stringType().url()).optional(),
  compatibility: McpbManifestCompatibilitySchema$2.optional(),
  user_config: recordType(stringType(), McpbUserConfigurationOptionSchema$2).optional()
}).passthrough().refine((data) => !!(data.dxt_version || data.manifest_version), {
  message: "Either 'dxt_version' (deprecated) or 'manifest_version' must be provided"
});
const MANIFEST_VERSION$1 = "0.3";
const LOCALE_PLACEHOLDER_REGEX$1 = /\$\{locale\}/i;
const BCP47_REGEX$1 = /^[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const ICON_SIZE_REGEX$1 = /^\d+x\d+$/;
const McpServerConfigSchema$1 = objectType({
  command: stringType(),
  args: arrayType(stringType()).optional(),
  env: recordType(stringType(), stringType()).optional()
});
const McpbManifestAuthorSchema$1 = objectType({
  name: stringType(),
  email: stringType().email().optional(),
  url: stringType().url().optional()
});
const McpbManifestRepositorySchema$1 = objectType({
  type: stringType(),
  url: stringType().url()
});
const McpbManifestPlatformOverrideSchema$1 = McpServerConfigSchema$1.partial();
const McpbManifestMcpConfigSchema$1 = McpServerConfigSchema$1.extend({
  platform_overrides: recordType(stringType(), McpbManifestPlatformOverrideSchema$1).optional()
});
const McpbManifestServerSchema$1 = objectType({
  type: enumType(["python", "node", "binary"]),
  entry_point: stringType(),
  mcp_config: McpbManifestMcpConfigSchema$1
});
const McpbManifestCompatibilitySchema$1 = objectType({
  claude_desktop: stringType().optional(),
  platforms: arrayType(enumType(["darwin", "win32", "linux"])).optional(),
  runtimes: objectType({
    python: stringType().optional(),
    node: stringType().optional()
  }).optional()
}).passthrough();
const McpbManifestToolSchema$1 = objectType({
  name: stringType(),
  description: stringType().optional()
});
const McpbManifestPromptSchema$1 = objectType({
  name: stringType(),
  description: stringType().optional(),
  arguments: arrayType(stringType()).optional(),
  text: stringType()
});
const McpbUserConfigurationOptionSchema$1 = objectType({
  type: enumType(["string", "number", "boolean", "directory", "file"]),
  title: stringType(),
  description: stringType(),
  required: booleanType().optional(),
  default: unionType([stringType(), numberType(), booleanType(), arrayType(stringType())]).optional(),
  multiple: booleanType().optional(),
  sensitive: booleanType().optional(),
  min: numberType().optional(),
  max: numberType().optional()
});
const McpbManifestLocalizationSchema$1 = objectType({
  resources: stringType().regex(LOCALE_PLACEHOLDER_REGEX$1, 'resources must include a "${locale}" placeholder'),
  default_locale: stringType().regex(BCP47_REGEX$1, "default_locale must be a valid BCP 47 locale identifier")
}).passthrough();
const McpbManifestIconSchema$1 = objectType({
  src: stringType(),
  size: stringType().regex(ICON_SIZE_REGEX$1, 'size must be in the format "WIDTHxHEIGHT" (e.g., "16x16")'),
  theme: stringType().min(1).optional()
}).passthrough();
objectType({
  $schema: stringType().optional(),
  dxt_version: literalType(MANIFEST_VERSION$1).optional().describe("@deprecated Use manifest_version instead"),
  manifest_version: literalType(MANIFEST_VERSION$1).optional(),
  name: stringType(),
  display_name: stringType().optional(),
  version: stringType(),
  description: stringType(),
  long_description: stringType().optional(),
  author: McpbManifestAuthorSchema$1,
  repository: McpbManifestRepositorySchema$1.optional(),
  homepage: stringType().url().optional(),
  documentation: stringType().url().optional(),
  support: stringType().url().optional(),
  icon: stringType().optional(),
  icons: arrayType(McpbManifestIconSchema$1).optional(),
  screenshots: arrayType(stringType()).optional(),
  localization: McpbManifestLocalizationSchema$1.optional(),
  server: McpbManifestServerSchema$1,
  tools: arrayType(McpbManifestToolSchema$1).optional(),
  tools_generated: booleanType().optional(),
  prompts: arrayType(McpbManifestPromptSchema$1).optional(),
  prompts_generated: booleanType().optional(),
  keywords: arrayType(stringType()).optional(),
  license: stringType().optional(),
  privacy_policies: arrayType(stringType().url()).optional(),
  compatibility: McpbManifestCompatibilitySchema$1.optional(),
  user_config: recordType(stringType(), McpbUserConfigurationOptionSchema$1).optional(),
  _meta: recordType(stringType(), recordType(stringType(), anyType())).optional()
}).passthrough().refine((data) => !!(data.dxt_version || data.manifest_version), {
  message: "Either 'dxt_version' (deprecated) or 'manifest_version' must be provided"
});
const MANIFEST_VERSION = "0.4";
const LOCALE_PLACEHOLDER_REGEX = /\$\{locale\}/i;
const BCP47_REGEX = /^[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const ICON_SIZE_REGEX = /^\d+x\d+$/;
const McpServerConfigSchema = objectType({
  command: stringType(),
  args: arrayType(stringType()).optional(),
  env: recordType(stringType(), stringType()).optional()
});
const McpbManifestAuthorSchema = objectType({
  name: stringType(),
  email: stringType().email().optional(),
  url: stringType().url().optional()
});
const McpbManifestRepositorySchema = objectType({
  type: stringType(),
  url: stringType().url()
});
const McpbManifestPlatformOverrideSchema = McpServerConfigSchema.partial();
const McpbManifestMcpConfigSchema = McpServerConfigSchema.extend({
  platform_overrides: recordType(stringType(), McpbManifestPlatformOverrideSchema).optional()
});
const McpbManifestServerSchema = objectType({
  type: enumType(["python", "node", "binary", "uv"]),
  entry_point: stringType(),
  // mcp_config is optional for UV type (UV handles execution)
  mcp_config: McpbManifestMcpConfigSchema.optional()
});
const McpbManifestCompatibilitySchema = objectType({
  claude_desktop: stringType().optional(),
  platforms: arrayType(enumType(["darwin", "win32", "linux"])).optional(),
  runtimes: objectType({
    python: stringType().optional(),
    node: stringType().optional()
  }).optional()
}).passthrough();
const McpbManifestToolSchema = objectType({
  name: stringType(),
  description: stringType().optional()
});
const McpbManifestPromptSchema = objectType({
  name: stringType(),
  description: stringType().optional(),
  arguments: arrayType(stringType()).optional(),
  text: stringType()
});
const McpbUserConfigurationOptionSchema = objectType({
  type: enumType(["string", "number", "boolean", "directory", "file"]),
  title: stringType(),
  description: stringType(),
  required: booleanType().optional(),
  default: unionType([stringType(), numberType(), booleanType(), arrayType(stringType())]).optional(),
  multiple: booleanType().optional(),
  sensitive: booleanType().optional(),
  min: numberType().optional(),
  max: numberType().optional()
});
const McpbManifestLocalizationSchema = objectType({
  resources: stringType().regex(LOCALE_PLACEHOLDER_REGEX, 'resources must include a "${locale}" placeholder'),
  default_locale: stringType().regex(BCP47_REGEX, "default_locale must be a valid BCP 47 locale identifier")
}).passthrough();
const McpbManifestIconSchema = objectType({
  src: stringType(),
  size: stringType().regex(ICON_SIZE_REGEX, 'size must be in the format "WIDTHxHEIGHT" (e.g., "16x16")'),
  theme: stringType().min(1).optional()
}).passthrough();
objectType({
  $schema: stringType().optional(),
  dxt_version: literalType(MANIFEST_VERSION).optional().describe("@deprecated Use manifest_version instead"),
  manifest_version: literalType(MANIFEST_VERSION).optional(),
  name: stringType(),
  display_name: stringType().optional(),
  version: stringType(),
  description: stringType(),
  long_description: stringType().optional(),
  author: McpbManifestAuthorSchema,
  repository: McpbManifestRepositorySchema.optional(),
  homepage: stringType().url().optional(),
  documentation: stringType().url().optional(),
  support: stringType().url().optional(),
  icon: stringType().optional(),
  icons: arrayType(McpbManifestIconSchema).optional(),
  screenshots: arrayType(stringType()).optional(),
  localization: McpbManifestLocalizationSchema.optional(),
  server: McpbManifestServerSchema,
  tools: arrayType(McpbManifestToolSchema).optional(),
  tools_generated: booleanType().optional(),
  prompts: arrayType(McpbManifestPromptSchema).optional(),
  prompts_generated: booleanType().optional(),
  keywords: arrayType(stringType()).optional(),
  license: stringType().optional(),
  privacy_policies: arrayType(stringType().url()).optional(),
  compatibility: McpbManifestCompatibilitySchema.optional(),
  user_config: recordType(stringType(), McpbUserConfigurationOptionSchema).optional(),
  _meta: recordType(stringType(), recordType(stringType(), anyType())).optional()
}).passthrough().refine((data) => !!(data.dxt_version || data.manifest_version), {
  message: "Either 'dxt_version' (deprecated) or 'manifest_version' must be provided"
});
var ignore = { exports: {} };
var hasRequiredIgnore;
function requireIgnore() {
  if (hasRequiredIgnore) return ignore.exports;
  hasRequiredIgnore = 1;
  (function(module2) {
    function makeArray(subject) {
      return Array.isArray(subject) ? subject : [subject];
    }
    const UNDEFINED = void 0;
    const EMPTY = "";
    const SPACE = " ";
    const ESCAPE = "\\";
    const REGEX_TEST_BLANK_LINE = /^\s+$/;
    const REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
    const REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
    const REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
    const REGEX_SPLITALL_CRLF = /\r?\n/g;
    const REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;
    const REGEX_TEST_TRAILING_SLASH = /\/$/;
    const SLASH = "/";
    let TMP_KEY_IGNORE = "node-ignore";
    if (typeof Symbol !== "undefined") {
      TMP_KEY_IGNORE = Symbol.for("node-ignore");
    }
    const KEY_IGNORE = TMP_KEY_IGNORE;
    const define = (object, key, value) => {
      Object.defineProperty(object, key, { value });
      return value;
    };
    const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;
    const RETURN_FALSE = () => false;
    const sanitizeRange = (range) => range.replace(
      REGEX_REGEXP_RANGE,
      (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0) ? match : EMPTY
    );
    const cleanRangeBackSlash = (slashes) => {
      const { length } = slashes;
      return slashes.slice(0, length - length % 2);
    };
    const REPLACERS = [
      [
        // Remove BOM
        // TODO:
        // Other similar zero-width characters?
        /^\uFEFF/,
        () => EMPTY
      ],
      // > Trailing spaces are ignored unless they are quoted with backslash ("\")
      [
        // (a\ ) -> (a )
        // (a  ) -> (a)
        // (a ) -> (a)
        // (a \ ) -> (a  )
        /((?:\\\\)*?)(\\?\s+)$/,
        (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY)
      ],
      // Replace (\ ) with ' '
      // (\ ) -> ' '
      // (\\ ) -> '\\ '
      // (\\\ ) -> '\\ '
      [
        /(\\+?)\s/g,
        (_, m1) => {
          const { length } = m1;
          return m1.slice(0, length - length % 2) + SPACE;
        }
      ],
      // Escape metacharacters
      // which is written down by users but means special for regular expressions.
      // > There are 12 characters with special meanings:
      // > - the backslash \,
      // > - the caret ^,
      // > - the dollar sign $,
      // > - the period or dot .,
      // > - the vertical bar or pipe symbol |,
      // > - the question mark ?,
      // > - the asterisk or star *,
      // > - the plus sign +,
      // > - the opening parenthesis (,
      // > - the closing parenthesis ),
      // > - and the opening square bracket [,
      // > - the opening curly brace {,
      // > These special characters are often called "metacharacters".
      [
        /[\\$.|*+(){^]/g,
        (match) => `\\${match}`
      ],
      [
        // > a question mark (?) matches a single character
        /(?!\\)\?/g,
        () => "[^/]"
      ],
      // leading slash
      [
        // > A leading slash matches the beginning of the pathname.
        // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
        // A leading slash matches the beginning of the pathname
        /^\//,
        () => "^"
      ],
      // replace special metacharacter slash after the leading slash
      [
        /\//g,
        () => "\\/"
      ],
      [
        // > A leading "**" followed by a slash means match in all directories.
        // > For example, "**/foo" matches file or directory "foo" anywhere,
        // > the same as pattern "foo".
        // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
        // >   under directory "foo".
        // Notice that the '*'s have been replaced as '\\*'
        /^\^*\\\*\\\*\\\//,
        // '**/foo' <-> 'foo'
        () => "^(?:.*\\/)?"
      ],
      // starting
      [
        // there will be no leading '/'
        //   (which has been replaced by section "leading slash")
        // If starts with '**', adding a '^' to the regular expression also works
        /^(?=[^^])/,
        function startingReplacer() {
          return !/\/(?!$)/.test(this) ? "(?:^|\\/)" : "^";
        }
      ],
      // two globstars
      [
        // Use lookahead assertions so that we could match more than one `'/**'`
        /\\\/\\\*\\\*(?=\\\/|$)/g,
        // Zero, one or several directories
        // should not use '*', or it will be replaced by the next replacer
        // Check if it is not the last `'/**'`
        (_, index, str) => index + 6 < str.length ? "(?:\\/[^\\/]+)*" : "\\/.+"
      ],
      // normal intermediate wildcards
      [
        // Never replace escaped '*'
        // ignore rule '\*' will match the path '*'
        // 'abc.*/' -> go
        // 'abc.*'  -> skip this rule,
        //    coz trailing single wildcard will be handed by [trailing wildcard]
        /(^|[^\\]+)(\\\*)+(?=.+)/g,
        // '*.js' matches '.js'
        // '*.js' doesn't match 'abc'
        (_, p1, p2) => {
          const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
          return p1 + unescaped;
        }
      ],
      [
        // unescape, revert step 3 except for back slash
        // For example, if a user escape a '\\*',
        // after step 3, the result will be '\\\\\\*'
        /\\\\\\(?=[$.|*+(){^])/g,
        () => ESCAPE
      ],
      [
        // '\\\\' -> '\\'
        /\\\\/g,
        () => ESCAPE
      ],
      [
        // > The range notation, e.g. [a-zA-Z],
        // > can be used to match one of the characters in a range.
        // `\` is escaped by step 3
        /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
        (match, leadEscape, range, endEscape, close) => leadEscape === ESCAPE ? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}` : close === "]" ? endEscape.length % 2 === 0 ? `[${sanitizeRange(range)}${endEscape}]` : "[]" : "[]"
      ],
      // ending
      [
        // 'js' will not match 'js.'
        // 'ab' will not match 'abc'
        /(?:[^*])$/,
        // WTF!
        // https://git-scm.com/docs/gitignore
        // changes in [2.22.1](https://git-scm.com/docs/gitignore/2.22.1)
        // which re-fixes #24, #38
        // > If there is a separator at the end of the pattern then the pattern
        // > will only match directories, otherwise the pattern can match both
        // > files and directories.
        // 'js*' will not match 'a.js'
        // 'js/' will not match 'a.js'
        // 'js' will match 'a.js' and 'a.js/'
        (match) => /\/$/.test(match) ? `${match}$` : `${match}(?=$|\\/$)`
      ]
    ];
    const REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\\\*$/;
    const MODE_IGNORE = "regex";
    const MODE_CHECK_IGNORE = "checkRegex";
    const UNDERSCORE = "_";
    const TRAILING_WILD_CARD_REPLACERS = {
      [MODE_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      },
      [MODE_CHECK_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]*` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      }
    };
    const makeRegexPrefix = (pattern) => REPLACERS.reduce(
      (prev, [matcher, replacer]) => prev.replace(matcher, replacer.bind(pattern)),
      pattern
    );
    const isString = (subject) => typeof subject === "string";
    const checkPattern = (pattern) => pattern && isString(pattern) && !REGEX_TEST_BLANK_LINE.test(pattern) && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) && pattern.indexOf("#") !== 0;
    const splitPattern = (pattern) => pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);
    class IgnoreRule {
      constructor(pattern, mark, body, ignoreCase, negative, prefix) {
        this.pattern = pattern;
        this.mark = mark;
        this.negative = negative;
        define(this, "body", body);
        define(this, "ignoreCase", ignoreCase);
        define(this, "regexPrefix", prefix);
      }
      get regex() {
        const key = UNDERSCORE + MODE_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_IGNORE, key);
      }
      get checkRegex() {
        const key = UNDERSCORE + MODE_CHECK_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_CHECK_IGNORE, key);
      }
      _make(mode, key) {
        const str = this.regexPrefix.replace(
          REGEX_REPLACE_TRAILING_WILDCARD,
          // It does not need to bind pattern
          TRAILING_WILD_CARD_REPLACERS[mode]
        );
        const regex = this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);
        return define(this, key, regex);
      }
    }
    const createRule = ({
      pattern,
      mark
    }, ignoreCase) => {
      let negative = false;
      let body = pattern;
      if (body.indexOf("!") === 0) {
        negative = true;
        body = body.substr(1);
      }
      body = body.replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!").replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");
      const regexPrefix = makeRegexPrefix(body);
      return new IgnoreRule(
        pattern,
        mark,
        body,
        ignoreCase,
        negative,
        regexPrefix
      );
    };
    class RuleManager {
      constructor(ignoreCase) {
        this._ignoreCase = ignoreCase;
        this._rules = [];
      }
      _add(pattern) {
        if (pattern && pattern[KEY_IGNORE]) {
          this._rules = this._rules.concat(pattern._rules._rules);
          this._added = true;
          return;
        }
        if (isString(pattern)) {
          pattern = {
            pattern
          };
        }
        if (checkPattern(pattern.pattern)) {
          const rule = createRule(pattern, this._ignoreCase);
          this._added = true;
          this._rules.push(rule);
        }
      }
      // @param {Array<string> | string | Ignore} pattern
      add(pattern) {
        this._added = false;
        makeArray(
          isString(pattern) ? splitPattern(pattern) : pattern
        ).forEach(this._add, this);
        return this._added;
      }
      // Test one single path without recursively checking parent directories
      //
      // - checkUnignored `boolean` whether should check if the path is unignored,
      //   setting `checkUnignored` to `false` could reduce additional
      //   path matching.
      // - check `string` either `MODE_IGNORE` or `MODE_CHECK_IGNORE`
      // @returns {TestResult} true if a file is ignored
      test(path, checkUnignored, mode) {
        let ignored = false;
        let unignored = false;
        let matchedRule;
        this._rules.forEach((rule) => {
          const { negative } = rule;
          if (unignored === negative && ignored !== unignored || negative && !ignored && !unignored && !checkUnignored) {
            return;
          }
          const matched = rule[mode].test(path);
          if (!matched) {
            return;
          }
          ignored = !negative;
          unignored = negative;
          matchedRule = negative ? UNDEFINED : rule;
        });
        const ret = {
          ignored,
          unignored
        };
        if (matchedRule) {
          ret.rule = matchedRule;
        }
        return ret;
      }
    }
    const throwError = (message, Ctor) => {
      throw new Ctor(message);
    };
    const checkPath = (path, originalPath, doThrow) => {
      if (!isString(path)) {
        return doThrow(
          `path must be a string, but got \`${originalPath}\``,
          TypeError
        );
      }
      if (!path) {
        return doThrow(`path must not be empty`, TypeError);
      }
      if (checkPath.isNotRelative(path)) {
        const r = "`path.relative()`d";
        return doThrow(
          `path should be a ${r} string, but got "${originalPath}"`,
          RangeError
        );
      }
      return true;
    };
    const isNotRelative = (path) => REGEX_TEST_INVALID_PATH.test(path);
    checkPath.isNotRelative = isNotRelative;
    checkPath.convert = (p) => p;
    class Ignore {
      constructor({
        ignorecase = true,
        ignoreCase = ignorecase,
        allowRelativePaths = false
      } = {}) {
        define(this, KEY_IGNORE, true);
        this._rules = new RuleManager(ignoreCase);
        this._strictPathCheck = !allowRelativePaths;
        this._initCache();
      }
      _initCache() {
        this._ignoreCache = /* @__PURE__ */ Object.create(null);
        this._testCache = /* @__PURE__ */ Object.create(null);
      }
      add(pattern) {
        if (this._rules.add(pattern)) {
          this._initCache();
        }
        return this;
      }
      // legacy
      addPattern(pattern) {
        return this.add(pattern);
      }
      // @returns {TestResult}
      _test(originalPath, cache, checkUnignored, slices) {
        const path = originalPath && checkPath.convert(originalPath);
        checkPath(
          path,
          originalPath,
          this._strictPathCheck ? throwError : RETURN_FALSE
        );
        return this._t(path, cache, checkUnignored, slices);
      }
      checkIgnore(path) {
        if (!REGEX_TEST_TRAILING_SLASH.test(path)) {
          return this.test(path);
        }
        const slices = path.split(SLASH).filter(Boolean);
        slices.pop();
        if (slices.length) {
          const parent = this._t(
            slices.join(SLASH) + SLASH,
            this._testCache,
            true,
            slices
          );
          if (parent.ignored) {
            return parent;
          }
        }
        return this._rules.test(path, false, MODE_CHECK_IGNORE);
      }
      _t(path, cache, checkUnignored, slices) {
        if (path in cache) {
          return cache[path];
        }
        if (!slices) {
          slices = path.split(SLASH).filter(Boolean);
        }
        slices.pop();
        if (!slices.length) {
          return cache[path] = this._rules.test(path, checkUnignored, MODE_IGNORE);
        }
        const parent = this._t(
          slices.join(SLASH) + SLASH,
          cache,
          checkUnignored,
          slices
        );
        return cache[path] = parent.ignored ? parent : this._rules.test(path, checkUnignored, MODE_IGNORE);
      }
      ignores(path) {
        return this._test(path, this._ignoreCache, false).ignored;
      }
      createFilter() {
        return (path) => !this.ignores(path);
      }
      filter(paths) {
        return makeArray(paths).filter(this.createFilter());
      }
      // @returns {TestResult}
      test(path) {
        return this._test(path, this._testCache, true);
      }
    }
    const factory = (options) => new Ignore(options);
    const isPathValid = (path) => checkPath(path && checkPath.convert(path), path, RETURN_FALSE);
    const setupWindows = () => {
      const makePosix = (str) => /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/");
      checkPath.convert = makePosix;
      const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
      checkPath.isNotRelative = (path) => REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path) || isNotRelative(path);
    };
    if (
      // Detect `process` so that it can run in browsers.
      typeof process !== "undefined" && process.platform === "win32"
    ) {
      setupWindows();
    }
    module2.exports = factory;
    factory.default = factory;
    module2.exports.isPathValid = isPathValid;
    define(module2.exports, Symbol.for("setupWindows"), setupWindows);
  })(ignore);
  return ignore.exports;
}
requireIgnore();
var lib$4 = {};
var DestroyerOfModules = {};
var fs$1 = {};
var universalify = {};
var hasRequiredUniversalify;
function requireUniversalify() {
  if (hasRequiredUniversalify) return universalify;
  hasRequiredUniversalify = 1;
  universalify.fromCallback = function(fn) {
    return Object.defineProperty(function(...args) {
      if (typeof args[args.length - 1] === "function") fn.apply(this, args);
      else {
        return new Promise((resolve, reject) => {
          fn.call(
            this,
            ...args,
            (err, res) => err != null ? reject(err) : resolve(res)
          );
        });
      }
    }, "name", { value: fn.name });
  };
  universalify.fromPromise = function(fn) {
    return Object.defineProperty(function(...args) {
      const cb = args[args.length - 1];
      if (typeof cb !== "function") return fn.apply(this, args);
      else fn.apply(this, args.slice(0, -1)).then((r) => cb(null, r), cb);
    }, "name", { value: fn.name });
  };
  return universalify;
}
var polyfills;
var hasRequiredPolyfills;
function requirePolyfills() {
  if (hasRequiredPolyfills) return polyfills;
  hasRequiredPolyfills = 1;
  var constants = require$$0;
  var origCwd = process.cwd;
  var cwd = null;
  var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
  process.cwd = function() {
    if (!cwd)
      cwd = origCwd.call(process);
    return cwd;
  };
  try {
    process.cwd();
  } catch (er) {
  }
  if (typeof process.chdir === "function") {
    var chdir = process.chdir;
    process.chdir = function(d) {
      cwd = null;
      chdir.call(process, d);
    };
    if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir);
  }
  polyfills = patch;
  function patch(fs2) {
    if (constants.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
      patchLchmod(fs2);
    }
    if (!fs2.lutimes) {
      patchLutimes(fs2);
    }
    fs2.chown = chownFix(fs2.chown);
    fs2.fchown = chownFix(fs2.fchown);
    fs2.lchown = chownFix(fs2.lchown);
    fs2.chmod = chmodFix(fs2.chmod);
    fs2.fchmod = chmodFix(fs2.fchmod);
    fs2.lchmod = chmodFix(fs2.lchmod);
    fs2.chownSync = chownFixSync(fs2.chownSync);
    fs2.fchownSync = chownFixSync(fs2.fchownSync);
    fs2.lchownSync = chownFixSync(fs2.lchownSync);
    fs2.chmodSync = chmodFixSync(fs2.chmodSync);
    fs2.fchmodSync = chmodFixSync(fs2.fchmodSync);
    fs2.lchmodSync = chmodFixSync(fs2.lchmodSync);
    fs2.stat = statFix(fs2.stat);
    fs2.fstat = statFix(fs2.fstat);
    fs2.lstat = statFix(fs2.lstat);
    fs2.statSync = statFixSync(fs2.statSync);
    fs2.fstatSync = statFixSync(fs2.fstatSync);
    fs2.lstatSync = statFixSync(fs2.lstatSync);
    if (fs2.chmod && !fs2.lchmod) {
      fs2.lchmod = function(path, mode, cb) {
        if (cb) process.nextTick(cb);
      };
      fs2.lchmodSync = function() {
      };
    }
    if (fs2.chown && !fs2.lchown) {
      fs2.lchown = function(path, uid, gid, cb) {
        if (cb) process.nextTick(cb);
      };
      fs2.lchownSync = function() {
      };
    }
    if (platform === "win32") {
      fs2.rename = typeof fs2.rename !== "function" ? fs2.rename : function(fs$rename) {
        function rename(from, to, cb) {
          var start = Date.now();
          var backoff = 0;
          fs$rename(from, to, function CB(er) {
            if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 6e4) {
              setTimeout(function() {
                fs2.stat(to, function(stater, st) {
                  if (stater && stater.code === "ENOENT")
                    fs$rename(from, to, CB);
                  else
                    cb(er);
                });
              }, backoff);
              if (backoff < 100)
                backoff += 10;
              return;
            }
            if (cb) cb(er);
          });
        }
        if (Object.setPrototypeOf) Object.setPrototypeOf(rename, fs$rename);
        return rename;
      }(fs2.rename);
    }
    fs2.read = typeof fs2.read !== "function" ? fs2.read : function(fs$read) {
      function read(fd, buffer, offset, length, position, callback_) {
        var callback;
        if (callback_ && typeof callback_ === "function") {
          var eagCounter = 0;
          callback = function(er, _, __) {
            if (er && er.code === "EAGAIN" && eagCounter < 10) {
              eagCounter++;
              return fs$read.call(fs2, fd, buffer, offset, length, position, callback);
            }
            callback_.apply(this, arguments);
          };
        }
        return fs$read.call(fs2, fd, buffer, offset, length, position, callback);
      }
      if (Object.setPrototypeOf) Object.setPrototypeOf(read, fs$read);
      return read;
    }(fs2.read);
    fs2.readSync = typeof fs2.readSync !== "function" ? fs2.readSync : /* @__PURE__ */ function(fs$readSync) {
      return function(fd, buffer, offset, length, position) {
        var eagCounter = 0;
        while (true) {
          try {
            return fs$readSync.call(fs2, fd, buffer, offset, length, position);
          } catch (er) {
            if (er.code === "EAGAIN" && eagCounter < 10) {
              eagCounter++;
              continue;
            }
            throw er;
          }
        }
      };
    }(fs2.readSync);
    function patchLchmod(fs3) {
      fs3.lchmod = function(path, mode, callback) {
        fs3.open(
          path,
          constants.O_WRONLY | constants.O_SYMLINK,
          mode,
          function(err, fd) {
            if (err) {
              if (callback) callback(err);
              return;
            }
            fs3.fchmod(fd, mode, function(err2) {
              fs3.close(fd, function(err22) {
                if (callback) callback(err2 || err22);
              });
            });
          }
        );
      };
      fs3.lchmodSync = function(path, mode) {
        var fd = fs3.openSync(path, constants.O_WRONLY | constants.O_SYMLINK, mode);
        var threw = true;
        var ret;
        try {
          ret = fs3.fchmodSync(fd, mode);
          threw = false;
        } finally {
          if (threw) {
            try {
              fs3.closeSync(fd);
            } catch (er) {
            }
          } else {
            fs3.closeSync(fd);
          }
        }
        return ret;
      };
    }
    function patchLutimes(fs3) {
      if (constants.hasOwnProperty("O_SYMLINK") && fs3.futimes) {
        fs3.lutimes = function(path, at, mt, cb) {
          fs3.open(path, constants.O_SYMLINK, function(er, fd) {
            if (er) {
              if (cb) cb(er);
              return;
            }
            fs3.futimes(fd, at, mt, function(er2) {
              fs3.close(fd, function(er22) {
                if (cb) cb(er2 || er22);
              });
            });
          });
        };
        fs3.lutimesSync = function(path, at, mt) {
          var fd = fs3.openSync(path, constants.O_SYMLINK);
          var ret;
          var threw = true;
          try {
            ret = fs3.futimesSync(fd, at, mt);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs3.closeSync(fd);
              } catch (er) {
              }
            } else {
              fs3.closeSync(fd);
            }
          }
          return ret;
        };
      } else if (fs3.futimes) {
        fs3.lutimes = function(_a, _b, _c, cb) {
          if (cb) process.nextTick(cb);
        };
        fs3.lutimesSync = function() {
        };
      }
    }
    function chmodFix(orig) {
      if (!orig) return orig;
      return function(target, mode, cb) {
        return orig.call(fs2, target, mode, function(er) {
          if (chownErOk(er)) er = null;
          if (cb) cb.apply(this, arguments);
        });
      };
    }
    function chmodFixSync(orig) {
      if (!orig) return orig;
      return function(target, mode) {
        try {
          return orig.call(fs2, target, mode);
        } catch (er) {
          if (!chownErOk(er)) throw er;
        }
      };
    }
    function chownFix(orig) {
      if (!orig) return orig;
      return function(target, uid, gid, cb) {
        return orig.call(fs2, target, uid, gid, function(er) {
          if (chownErOk(er)) er = null;
          if (cb) cb.apply(this, arguments);
        });
      };
    }
    function chownFixSync(orig) {
      if (!orig) return orig;
      return function(target, uid, gid) {
        try {
          return orig.call(fs2, target, uid, gid);
        } catch (er) {
          if (!chownErOk(er)) throw er;
        }
      };
    }
    function statFix(orig) {
      if (!orig) return orig;
      return function(target, options, cb) {
        if (typeof options === "function") {
          cb = options;
          options = null;
        }
        function callback(er, stats) {
          if (stats) {
            if (stats.uid < 0) stats.uid += 4294967296;
            if (stats.gid < 0) stats.gid += 4294967296;
          }
          if (cb) cb.apply(this, arguments);
        }
        return options ? orig.call(fs2, target, options, callback) : orig.call(fs2, target, callback);
      };
    }
    function statFixSync(orig) {
      if (!orig) return orig;
      return function(target, options) {
        var stats = options ? orig.call(fs2, target, options) : orig.call(fs2, target);
        if (stats) {
          if (stats.uid < 0) stats.uid += 4294967296;
          if (stats.gid < 0) stats.gid += 4294967296;
        }
        return stats;
      };
    }
    function chownErOk(er) {
      if (!er)
        return true;
      if (er.code === "ENOSYS")
        return true;
      var nonroot = !process.getuid || process.getuid() !== 0;
      if (nonroot) {
        if (er.code === "EINVAL" || er.code === "EPERM")
          return true;
      }
      return false;
    }
  }
  return polyfills;
}
var legacyStreams;
var hasRequiredLegacyStreams;
function requireLegacyStreams() {
  if (hasRequiredLegacyStreams) return legacyStreams;
  hasRequiredLegacyStreams = 1;
  var Stream = require$$5.Stream;
  legacyStreams = legacy;
  function legacy(fs2) {
    return {
      ReadStream,
      WriteStream
    };
    function ReadStream(path, options) {
      if (!(this instanceof ReadStream)) return new ReadStream(path, options);
      Stream.call(this);
      var self2 = this;
      this.path = path;
      this.fd = null;
      this.readable = true;
      this.paused = false;
      this.flags = "r";
      this.mode = 438;
      this.bufferSize = 64 * 1024;
      options = options || {};
      var keys = Object.keys(options);
      for (var index = 0, length = keys.length; index < length; index++) {
        var key = keys[index];
        this[key] = options[key];
      }
      if (this.encoding) this.setEncoding(this.encoding);
      if (this.start !== void 0) {
        if ("number" !== typeof this.start) {
          throw TypeError("start must be a Number");
        }
        if (this.end === void 0) {
          this.end = Infinity;
        } else if ("number" !== typeof this.end) {
          throw TypeError("end must be a Number");
        }
        if (this.start > this.end) {
          throw new Error("start must be <= end");
        }
        this.pos = this.start;
      }
      if (this.fd !== null) {
        process.nextTick(function() {
          self2._read();
        });
        return;
      }
      fs2.open(this.path, this.flags, this.mode, function(err, fd) {
        if (err) {
          self2.emit("error", err);
          self2.readable = false;
          return;
        }
        self2.fd = fd;
        self2.emit("open", fd);
        self2._read();
      });
    }
    function WriteStream(path, options) {
      if (!(this instanceof WriteStream)) return new WriteStream(path, options);
      Stream.call(this);
      this.path = path;
      this.fd = null;
      this.writable = true;
      this.flags = "w";
      this.encoding = "binary";
      this.mode = 438;
      this.bytesWritten = 0;
      options = options || {};
      var keys = Object.keys(options);
      for (var index = 0, length = keys.length; index < length; index++) {
        var key = keys[index];
        this[key] = options[key];
      }
      if (this.start !== void 0) {
        if ("number" !== typeof this.start) {
          throw TypeError("start must be a Number");
        }
        if (this.start < 0) {
          throw new Error("start must be >= zero");
        }
        this.pos = this.start;
      }
      this.busy = false;
      this._queue = [];
      if (this.fd === null) {
        this._open = fs2.open;
        this._queue.push([this._open, this.path, this.flags, this.mode, void 0]);
        this.flush();
      }
    }
  }
  return legacyStreams;
}
var clone_1;
var hasRequiredClone;
function requireClone() {
  if (hasRequiredClone) return clone_1;
  hasRequiredClone = 1;
  clone_1 = clone;
  var getPrototypeOf = Object.getPrototypeOf || function(obj) {
    return obj.__proto__;
  };
  function clone(obj) {
    if (obj === null || typeof obj !== "object")
      return obj;
    if (obj instanceof Object)
      var copy2 = { __proto__: getPrototypeOf(obj) };
    else
      var copy2 = /* @__PURE__ */ Object.create(null);
    Object.getOwnPropertyNames(obj).forEach(function(key) {
      Object.defineProperty(copy2, key, Object.getOwnPropertyDescriptor(obj, key));
    });
    return copy2;
  }
  return clone_1;
}
var gracefulFs;
var hasRequiredGracefulFs;
function requireGracefulFs() {
  if (hasRequiredGracefulFs) return gracefulFs;
  hasRequiredGracefulFs = 1;
  var fs2 = require$$0$2;
  var polyfills2 = requirePolyfills();
  var legacy = requireLegacyStreams();
  var clone = requireClone();
  var util2 = require$$0$1;
  var gracefulQueue;
  var previousSymbol;
  if (typeof Symbol === "function" && typeof Symbol.for === "function") {
    gracefulQueue = Symbol.for("graceful-fs.queue");
    previousSymbol = Symbol.for("graceful-fs.previous");
  } else {
    gracefulQueue = "___graceful-fs.queue";
    previousSymbol = "___graceful-fs.previous";
  }
  function noop() {
  }
  function publishQueue(context, queue2) {
    Object.defineProperty(context, gracefulQueue, {
      get: function() {
        return queue2;
      }
    });
  }
  var debug = noop;
  if (util2.debuglog)
    debug = util2.debuglog("gfs4");
  else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
    debug = function() {
      var m = util2.format.apply(util2, arguments);
      m = "GFS4: " + m.split(/\n/).join("\nGFS4: ");
      console.error(m);
    };
  if (!fs2[gracefulQueue]) {
    var queue = heavyWorkWorker.commonjsGlobal[gracefulQueue] || [];
    publishQueue(fs2, queue);
    fs2.close = function(fs$close) {
      function close(fd, cb) {
        return fs$close.call(fs2, fd, function(err) {
          if (!err) {
            resetQueue();
          }
          if (typeof cb === "function")
            cb.apply(this, arguments);
        });
      }
      Object.defineProperty(close, previousSymbol, {
        value: fs$close
      });
      return close;
    }(fs2.close);
    fs2.closeSync = function(fs$closeSync) {
      function closeSync(fd) {
        fs$closeSync.apply(fs2, arguments);
        resetQueue();
      }
      Object.defineProperty(closeSync, previousSymbol, {
        value: fs$closeSync
      });
      return closeSync;
    }(fs2.closeSync);
    if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
      process.on("exit", function() {
        debug(fs2[gracefulQueue]);
        require$$2.equal(fs2[gracefulQueue].length, 0);
      });
    }
  }
  if (!heavyWorkWorker.commonjsGlobal[gracefulQueue]) {
    publishQueue(heavyWorkWorker.commonjsGlobal, fs2[gracefulQueue]);
  }
  gracefulFs = patch(clone(fs2));
  if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs2.__patched) {
    gracefulFs = patch(fs2);
    fs2.__patched = true;
  }
  function patch(fs3) {
    polyfills2(fs3);
    fs3.gracefulify = patch;
    fs3.createReadStream = createReadStream;
    fs3.createWriteStream = createWriteStream;
    var fs$readFile = fs3.readFile;
    fs3.readFile = readFile;
    function readFile(path, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      return go$readFile(path, options, cb);
      function go$readFile(path2, options2, cb2, startTime) {
        return fs$readFile(path2, options2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$readFile, [path2, options2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$writeFile = fs3.writeFile;
    fs3.writeFile = writeFile;
    function writeFile(path, data, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      return go$writeFile(path, data, options, cb);
      function go$writeFile(path2, data2, options2, cb2, startTime) {
        return fs$writeFile(path2, data2, options2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$writeFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$appendFile = fs3.appendFile;
    if (fs$appendFile)
      fs3.appendFile = appendFile;
    function appendFile(path, data, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      return go$appendFile(path, data, options, cb);
      function go$appendFile(path2, data2, options2, cb2, startTime) {
        return fs$appendFile(path2, data2, options2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$appendFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$copyFile = fs3.copyFile;
    if (fs$copyFile)
      fs3.copyFile = copyFile;
    function copyFile(src2, dest, flags, cb) {
      if (typeof flags === "function") {
        cb = flags;
        flags = 0;
      }
      return go$copyFile(src2, dest, flags, cb);
      function go$copyFile(src3, dest2, flags2, cb2, startTime) {
        return fs$copyFile(src3, dest2, flags2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$copyFile, [src3, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$readdir = fs3.readdir;
    fs3.readdir = readdir;
    var noReaddirOptionVersions = /^v[0-5]\./;
    function readdir(path, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path2, options2, cb2, startTime) {
        return fs$readdir(path2, fs$readdirCallback(
          path2,
          options2,
          cb2,
          startTime
        ));
      } : function go$readdir2(path2, options2, cb2, startTime) {
        return fs$readdir(path2, options2, fs$readdirCallback(
          path2,
          options2,
          cb2,
          startTime
        ));
      };
      return go$readdir(path, options, cb);
      function fs$readdirCallback(path2, options2, cb2, startTime) {
        return function(err, files) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([
              go$readdir,
              [path2, options2, cb2],
              err,
              startTime || Date.now(),
              Date.now()
            ]);
          else {
            if (files && files.sort)
              files.sort();
            if (typeof cb2 === "function")
              cb2.call(this, err, files);
          }
        };
      }
    }
    if (process.version.substr(0, 4) === "v0.8") {
      var legStreams = legacy(fs3);
      ReadStream = legStreams.ReadStream;
      WriteStream = legStreams.WriteStream;
    }
    var fs$ReadStream = fs3.ReadStream;
    if (fs$ReadStream) {
      ReadStream.prototype = Object.create(fs$ReadStream.prototype);
      ReadStream.prototype.open = ReadStream$open;
    }
    var fs$WriteStream = fs3.WriteStream;
    if (fs$WriteStream) {
      WriteStream.prototype = Object.create(fs$WriteStream.prototype);
      WriteStream.prototype.open = WriteStream$open;
    }
    Object.defineProperty(fs3, "ReadStream", {
      get: function() {
        return ReadStream;
      },
      set: function(val) {
        ReadStream = val;
      },
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(fs3, "WriteStream", {
      get: function() {
        return WriteStream;
      },
      set: function(val) {
        WriteStream = val;
      },
      enumerable: true,
      configurable: true
    });
    var FileReadStream = ReadStream;
    Object.defineProperty(fs3, "FileReadStream", {
      get: function() {
        return FileReadStream;
      },
      set: function(val) {
        FileReadStream = val;
      },
      enumerable: true,
      configurable: true
    });
    var FileWriteStream = WriteStream;
    Object.defineProperty(fs3, "FileWriteStream", {
      get: function() {
        return FileWriteStream;
      },
      set: function(val) {
        FileWriteStream = val;
      },
      enumerable: true,
      configurable: true
    });
    function ReadStream(path, options) {
      if (this instanceof ReadStream)
        return fs$ReadStream.apply(this, arguments), this;
      else
        return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
    }
    function ReadStream$open() {
      var that = this;
      open(that.path, that.flags, that.mode, function(err, fd) {
        if (err) {
          if (that.autoClose)
            that.destroy();
          that.emit("error", err);
        } else {
          that.fd = fd;
          that.emit("open", fd);
          that.read();
        }
      });
    }
    function WriteStream(path, options) {
      if (this instanceof WriteStream)
        return fs$WriteStream.apply(this, arguments), this;
      else
        return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
    }
    function WriteStream$open() {
      var that = this;
      open(that.path, that.flags, that.mode, function(err, fd) {
        if (err) {
          that.destroy();
          that.emit("error", err);
        } else {
          that.fd = fd;
          that.emit("open", fd);
        }
      });
    }
    function createReadStream(path, options) {
      return new fs3.ReadStream(path, options);
    }
    function createWriteStream(path, options) {
      return new fs3.WriteStream(path, options);
    }
    var fs$open = fs3.open;
    fs3.open = open;
    function open(path, flags, mode, cb) {
      if (typeof mode === "function")
        cb = mode, mode = null;
      return go$open(path, flags, mode, cb);
      function go$open(path2, flags2, mode2, cb2, startTime) {
        return fs$open(path2, flags2, mode2, function(err, fd) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$open, [path2, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    return fs3;
  }
  function enqueue(elem) {
    debug("ENQUEUE", elem[0].name, elem[1]);
    fs2[gracefulQueue].push(elem);
    retry();
  }
  var retryTimer;
  function resetQueue() {
    var now = Date.now();
    for (var i = 0; i < fs2[gracefulQueue].length; ++i) {
      if (fs2[gracefulQueue][i].length > 2) {
        fs2[gracefulQueue][i][3] = now;
        fs2[gracefulQueue][i][4] = now;
      }
    }
    retry();
  }
  function retry() {
    clearTimeout(retryTimer);
    retryTimer = void 0;
    if (fs2[gracefulQueue].length === 0)
      return;
    var elem = fs2[gracefulQueue].shift();
    var fn = elem[0];
    var args = elem[1];
    var err = elem[2];
    var startTime = elem[3];
    var lastTime = elem[4];
    if (startTime === void 0) {
      debug("RETRY", fn.name, args);
      fn.apply(null, args);
    } else if (Date.now() - startTime >= 6e4) {
      debug("TIMEOUT", fn.name, args);
      var cb = args.pop();
      if (typeof cb === "function")
        cb.call(null, err);
    } else {
      var sinceAttempt = Date.now() - lastTime;
      var sinceStart = Math.max(lastTime - startTime, 1);
      var desiredDelay = Math.min(sinceStart * 1.2, 100);
      if (sinceAttempt >= desiredDelay) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args.concat([startTime]));
      } else {
        fs2[gracefulQueue].push(elem);
      }
    }
    if (retryTimer === void 0) {
      retryTimer = setTimeout(retry, 0);
    }
  }
  return gracefulFs;
}
var hasRequiredFs$1;
function requireFs$1() {
  if (hasRequiredFs$1) return fs$1;
  hasRequiredFs$1 = 1;
  (function(exports$1) {
    const u = requireUniversalify().fromCallback;
    const fs2 = requireGracefulFs();
    const api = [
      "access",
      "appendFile",
      "chmod",
      "chown",
      "close",
      "copyFile",
      "fchmod",
      "fchown",
      "fdatasync",
      "fstat",
      "fsync",
      "ftruncate",
      "futimes",
      "lchmod",
      "lchown",
      "link",
      "lstat",
      "mkdir",
      "mkdtemp",
      "open",
      "opendir",
      "readdir",
      "readFile",
      "readlink",
      "realpath",
      "rename",
      "rm",
      "rmdir",
      "stat",
      "symlink",
      "truncate",
      "unlink",
      "utimes",
      "writeFile"
    ].filter((key) => {
      return typeof fs2[key] === "function";
    });
    Object.assign(exports$1, fs2);
    api.forEach((method) => {
      exports$1[method] = u(fs2[method]);
    });
    exports$1.exists = function(filename, callback) {
      if (typeof callback === "function") {
        return fs2.exists(filename, callback);
      }
      return new Promise((resolve) => {
        return fs2.exists(filename, resolve);
      });
    };
    exports$1.read = function(fd, buffer, offset, length, position, callback) {
      if (typeof callback === "function") {
        return fs2.read(fd, buffer, offset, length, position, callback);
      }
      return new Promise((resolve, reject) => {
        fs2.read(fd, buffer, offset, length, position, (err, bytesRead, buffer2) => {
          if (err) return reject(err);
          resolve({ bytesRead, buffer: buffer2 });
        });
      });
    };
    exports$1.write = function(fd, buffer, ...args) {
      if (typeof args[args.length - 1] === "function") {
        return fs2.write(fd, buffer, ...args);
      }
      return new Promise((resolve, reject) => {
        fs2.write(fd, buffer, ...args, (err, bytesWritten, buffer2) => {
          if (err) return reject(err);
          resolve({ bytesWritten, buffer: buffer2 });
        });
      });
    };
    if (typeof fs2.writev === "function") {
      exports$1.writev = function(fd, buffers, ...args) {
        if (typeof args[args.length - 1] === "function") {
          return fs2.writev(fd, buffers, ...args);
        }
        return new Promise((resolve, reject) => {
          fs2.writev(fd, buffers, ...args, (err, bytesWritten, buffers2) => {
            if (err) return reject(err);
            resolve({ bytesWritten, buffers: buffers2 });
          });
        });
      };
    }
    if (typeof fs2.realpath.native === "function") {
      exports$1.realpath.native = u(fs2.realpath.native);
    } else {
      process.emitWarning(
        "fs.realpath.native is not a function. Is fs being monkey-patched?",
        "Warning",
        "fs-extra-WARN0003"
      );
    }
  })(fs$1);
  return fs$1;
}
var makeDir$1 = {};
var utils$2 = {};
var hasRequiredUtils$2;
function requireUtils$2() {
  if (hasRequiredUtils$2) return utils$2;
  hasRequiredUtils$2 = 1;
  const path = require$$1;
  utils$2.checkPath = function checkPath(pth) {
    if (process.platform === "win32") {
      const pathHasInvalidWinCharacters = /[<>:"|?*]/.test(pth.replace(path.parse(pth).root, ""));
      if (pathHasInvalidWinCharacters) {
        const error = new Error(`Path contains invalid characters: ${pth}`);
        error.code = "EINVAL";
        throw error;
      }
    }
  };
  return utils$2;
}
var hasRequiredMakeDir$1;
function requireMakeDir$1() {
  if (hasRequiredMakeDir$1) return makeDir$1;
  hasRequiredMakeDir$1 = 1;
  const fs2 = /* @__PURE__ */ requireFs$1();
  const { checkPath } = /* @__PURE__ */ requireUtils$2();
  const getMode = (options) => {
    const defaults = { mode: 511 };
    if (typeof options === "number") return options;
    return { ...defaults, ...options }.mode;
  };
  makeDir$1.makeDir = async (dir, options) => {
    checkPath(dir);
    return fs2.mkdir(dir, {
      mode: getMode(options),
      recursive: true
    });
  };
  makeDir$1.makeDirSync = (dir, options) => {
    checkPath(dir);
    return fs2.mkdirSync(dir, {
      mode: getMode(options),
      recursive: true
    });
  };
  return makeDir$1;
}
var mkdirs$1;
var hasRequiredMkdirs$1;
function requireMkdirs$1() {
  if (hasRequiredMkdirs$1) return mkdirs$1;
  hasRequiredMkdirs$1 = 1;
  const u = requireUniversalify().fromPromise;
  const { makeDir: _makeDir, makeDirSync } = /* @__PURE__ */ requireMakeDir$1();
  const makeDir2 = u(_makeDir);
  mkdirs$1 = {
    mkdirs: makeDir2,
    mkdirsSync: makeDirSync,
    // alias
    mkdirp: makeDir2,
    mkdirpSync: makeDirSync,
    ensureDir: makeDir2,
    ensureDirSync: makeDirSync
  };
  return mkdirs$1;
}
var pathExists_1$1;
var hasRequiredPathExists$1;
function requirePathExists$1() {
  if (hasRequiredPathExists$1) return pathExists_1$1;
  hasRequiredPathExists$1 = 1;
  const u = requireUniversalify().fromPromise;
  const fs2 = /* @__PURE__ */ requireFs$1();
  function pathExists(path) {
    return fs2.access(path).then(() => true).catch(() => false);
  }
  pathExists_1$1 = {
    pathExists: u(pathExists),
    pathExistsSync: fs2.existsSync
  };
  return pathExists_1$1;
}
var utimes$1;
var hasRequiredUtimes$1;
function requireUtimes$1() {
  if (hasRequiredUtimes$1) return utimes$1;
  hasRequiredUtimes$1 = 1;
  const fs2 = requireGracefulFs();
  function utimesMillis(path, atime, mtime, callback) {
    fs2.open(path, "r+", (err, fd) => {
      if (err) return callback(err);
      fs2.futimes(fd, atime, mtime, (futimesErr) => {
        fs2.close(fd, (closeErr) => {
          if (callback) callback(futimesErr || closeErr);
        });
      });
    });
  }
  function utimesMillisSync(path, atime, mtime) {
    const fd = fs2.openSync(path, "r+");
    fs2.futimesSync(fd, atime, mtime);
    return fs2.closeSync(fd);
  }
  utimes$1 = {
    utimesMillis,
    utimesMillisSync
  };
  return utimes$1;
}
var stat$1;
var hasRequiredStat$1;
function requireStat$1() {
  if (hasRequiredStat$1) return stat$1;
  hasRequiredStat$1 = 1;
  const fs2 = /* @__PURE__ */ requireFs$1();
  const path = require$$1;
  const util2 = require$$0$1;
  function getStats(src2, dest, opts) {
    const statFunc = opts.dereference ? (file2) => fs2.stat(file2, { bigint: true }) : (file2) => fs2.lstat(file2, { bigint: true });
    return Promise.all([
      statFunc(src2),
      statFunc(dest).catch((err) => {
        if (err.code === "ENOENT") return null;
        throw err;
      })
    ]).then(([srcStat, destStat]) => ({ srcStat, destStat }));
  }
  function getStatsSync(src2, dest, opts) {
    let destStat;
    const statFunc = opts.dereference ? (file2) => fs2.statSync(file2, { bigint: true }) : (file2) => fs2.lstatSync(file2, { bigint: true });
    const srcStat = statFunc(src2);
    try {
      destStat = statFunc(dest);
    } catch (err) {
      if (err.code === "ENOENT") return { srcStat, destStat: null };
      throw err;
    }
    return { srcStat, destStat };
  }
  function checkPaths(src2, dest, funcName, opts, cb) {
    util2.callbackify(getStats)(src2, dest, opts, (err, stats) => {
      if (err) return cb(err);
      const { srcStat, destStat } = stats;
      if (destStat) {
        if (areIdentical(srcStat, destStat)) {
          const srcBaseName = path.basename(src2);
          const destBaseName = path.basename(dest);
          if (funcName === "move" && srcBaseName !== destBaseName && srcBaseName.toLowerCase() === destBaseName.toLowerCase()) {
            return cb(null, { srcStat, destStat, isChangingCase: true });
          }
          return cb(new Error("Source and destination must not be the same."));
        }
        if (srcStat.isDirectory() && !destStat.isDirectory()) {
          return cb(new Error(`Cannot overwrite non-directory '${dest}' with directory '${src2}'.`));
        }
        if (!srcStat.isDirectory() && destStat.isDirectory()) {
          return cb(new Error(`Cannot overwrite directory '${dest}' with non-directory '${src2}'.`));
        }
      }
      if (srcStat.isDirectory() && isSrcSubdir(src2, dest)) {
        return cb(new Error(errMsg(src2, dest, funcName)));
      }
      return cb(null, { srcStat, destStat });
    });
  }
  function checkPathsSync(src2, dest, funcName, opts) {
    const { srcStat, destStat } = getStatsSync(src2, dest, opts);
    if (destStat) {
      if (areIdentical(srcStat, destStat)) {
        const srcBaseName = path.basename(src2);
        const destBaseName = path.basename(dest);
        if (funcName === "move" && srcBaseName !== destBaseName && srcBaseName.toLowerCase() === destBaseName.toLowerCase()) {
          return { srcStat, destStat, isChangingCase: true };
        }
        throw new Error("Source and destination must not be the same.");
      }
      if (srcStat.isDirectory() && !destStat.isDirectory()) {
        throw new Error(`Cannot overwrite non-directory '${dest}' with directory '${src2}'.`);
      }
      if (!srcStat.isDirectory() && destStat.isDirectory()) {
        throw new Error(`Cannot overwrite directory '${dest}' with non-directory '${src2}'.`);
      }
    }
    if (srcStat.isDirectory() && isSrcSubdir(src2, dest)) {
      throw new Error(errMsg(src2, dest, funcName));
    }
    return { srcStat, destStat };
  }
  function checkParentPaths(src2, srcStat, dest, funcName, cb) {
    const srcParent = path.resolve(path.dirname(src2));
    const destParent = path.resolve(path.dirname(dest));
    if (destParent === srcParent || destParent === path.parse(destParent).root) return cb();
    fs2.stat(destParent, { bigint: true }, (err, destStat) => {
      if (err) {
        if (err.code === "ENOENT") return cb();
        return cb(err);
      }
      if (areIdentical(srcStat, destStat)) {
        return cb(new Error(errMsg(src2, dest, funcName)));
      }
      return checkParentPaths(src2, srcStat, destParent, funcName, cb);
    });
  }
  function checkParentPathsSync(src2, srcStat, dest, funcName) {
    const srcParent = path.resolve(path.dirname(src2));
    const destParent = path.resolve(path.dirname(dest));
    if (destParent === srcParent || destParent === path.parse(destParent).root) return;
    let destStat;
    try {
      destStat = fs2.statSync(destParent, { bigint: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    if (areIdentical(srcStat, destStat)) {
      throw new Error(errMsg(src2, dest, funcName));
    }
    return checkParentPathsSync(src2, srcStat, destParent, funcName);
  }
  function areIdentical(srcStat, destStat) {
    return destStat.ino && destStat.dev && destStat.ino === srcStat.ino && destStat.dev === srcStat.dev;
  }
  function isSrcSubdir(src2, dest) {
    const srcArr = path.resolve(src2).split(path.sep).filter((i) => i);
    const destArr = path.resolve(dest).split(path.sep).filter((i) => i);
    return srcArr.reduce((acc, cur, i) => acc && destArr[i] === cur, true);
  }
  function errMsg(src2, dest, funcName) {
    return `Cannot ${funcName} '${src2}' to a subdirectory of itself, '${dest}'.`;
  }
  stat$1 = {
    checkPaths,
    checkPathsSync,
    checkParentPaths,
    checkParentPathsSync,
    isSrcSubdir,
    areIdentical
  };
  return stat$1;
}
var copy_1$1;
var hasRequiredCopy$3;
function requireCopy$3() {
  if (hasRequiredCopy$3) return copy_1$1;
  hasRequiredCopy$3 = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const mkdirs2 = requireMkdirs$1().mkdirs;
  const pathExists = requirePathExists$1().pathExists;
  const utimesMillis = requireUtimes$1().utimesMillis;
  const stat2 = /* @__PURE__ */ requireStat$1();
  function copy2(src2, dest, opts, cb) {
    if (typeof opts === "function" && !cb) {
      cb = opts;
      opts = {};
    } else if (typeof opts === "function") {
      opts = { filter: opts };
    }
    cb = cb || function() {
    };
    opts = opts || {};
    opts.clobber = "clobber" in opts ? !!opts.clobber : true;
    opts.overwrite = "overwrite" in opts ? !!opts.overwrite : opts.clobber;
    if (opts.preserveTimestamps && process.arch === "ia32") {
      process.emitWarning(
        "Using the preserveTimestamps option in 32-bit node is not recommended;\n\n	see https://github.com/jprichardson/node-fs-extra/issues/269",
        "Warning",
        "fs-extra-WARN0001"
      );
    }
    stat2.checkPaths(src2, dest, "copy", opts, (err, stats) => {
      if (err) return cb(err);
      const { srcStat, destStat } = stats;
      stat2.checkParentPaths(src2, srcStat, dest, "copy", (err2) => {
        if (err2) return cb(err2);
        if (opts.filter) return handleFilter(checkParentDir, destStat, src2, dest, opts, cb);
        return checkParentDir(destStat, src2, dest, opts, cb);
      });
    });
  }
  function checkParentDir(destStat, src2, dest, opts, cb) {
    const destParent = path.dirname(dest);
    pathExists(destParent, (err, dirExists) => {
      if (err) return cb(err);
      if (dirExists) return getStats(destStat, src2, dest, opts, cb);
      mkdirs2(destParent, (err2) => {
        if (err2) return cb(err2);
        return getStats(destStat, src2, dest, opts, cb);
      });
    });
  }
  function handleFilter(onInclude, destStat, src2, dest, opts, cb) {
    Promise.resolve(opts.filter(src2, dest)).then((include) => {
      if (include) return onInclude(destStat, src2, dest, opts, cb);
      return cb();
    }, (error) => cb(error));
  }
  function startCopy(destStat, src2, dest, opts, cb) {
    if (opts.filter) return handleFilter(getStats, destStat, src2, dest, opts, cb);
    return getStats(destStat, src2, dest, opts, cb);
  }
  function getStats(destStat, src2, dest, opts, cb) {
    const stat3 = opts.dereference ? fs2.stat : fs2.lstat;
    stat3(src2, (err, srcStat) => {
      if (err) return cb(err);
      if (srcStat.isDirectory()) return onDir(srcStat, destStat, src2, dest, opts, cb);
      else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) return onFile(srcStat, destStat, src2, dest, opts, cb);
      else if (srcStat.isSymbolicLink()) return onLink(destStat, src2, dest, opts, cb);
      else if (srcStat.isSocket()) return cb(new Error(`Cannot copy a socket file: ${src2}`));
      else if (srcStat.isFIFO()) return cb(new Error(`Cannot copy a FIFO pipe: ${src2}`));
      return cb(new Error(`Unknown file: ${src2}`));
    });
  }
  function onFile(srcStat, destStat, src2, dest, opts, cb) {
    if (!destStat) return copyFile(srcStat, src2, dest, opts, cb);
    return mayCopyFile(srcStat, src2, dest, opts, cb);
  }
  function mayCopyFile(srcStat, src2, dest, opts, cb) {
    if (opts.overwrite) {
      fs2.unlink(dest, (err) => {
        if (err) return cb(err);
        return copyFile(srcStat, src2, dest, opts, cb);
      });
    } else if (opts.errorOnExist) {
      return cb(new Error(`'${dest}' already exists`));
    } else return cb();
  }
  function copyFile(srcStat, src2, dest, opts, cb) {
    fs2.copyFile(src2, dest, (err) => {
      if (err) return cb(err);
      if (opts.preserveTimestamps) return handleTimestampsAndMode(srcStat.mode, src2, dest, cb);
      return setDestMode(dest, srcStat.mode, cb);
    });
  }
  function handleTimestampsAndMode(srcMode, src2, dest, cb) {
    if (fileIsNotWritable(srcMode)) {
      return makeFileWritable(dest, srcMode, (err) => {
        if (err) return cb(err);
        return setDestTimestampsAndMode(srcMode, src2, dest, cb);
      });
    }
    return setDestTimestampsAndMode(srcMode, src2, dest, cb);
  }
  function fileIsNotWritable(srcMode) {
    return (srcMode & 128) === 0;
  }
  function makeFileWritable(dest, srcMode, cb) {
    return setDestMode(dest, srcMode | 128, cb);
  }
  function setDestTimestampsAndMode(srcMode, src2, dest, cb) {
    setDestTimestamps(src2, dest, (err) => {
      if (err) return cb(err);
      return setDestMode(dest, srcMode, cb);
    });
  }
  function setDestMode(dest, srcMode, cb) {
    return fs2.chmod(dest, srcMode, cb);
  }
  function setDestTimestamps(src2, dest, cb) {
    fs2.stat(src2, (err, updatedSrcStat) => {
      if (err) return cb(err);
      return utimesMillis(dest, updatedSrcStat.atime, updatedSrcStat.mtime, cb);
    });
  }
  function onDir(srcStat, destStat, src2, dest, opts, cb) {
    if (!destStat) return mkDirAndCopy(srcStat.mode, src2, dest, opts, cb);
    return copyDir(src2, dest, opts, cb);
  }
  function mkDirAndCopy(srcMode, src2, dest, opts, cb) {
    fs2.mkdir(dest, (err) => {
      if (err) return cb(err);
      copyDir(src2, dest, opts, (err2) => {
        if (err2) return cb(err2);
        return setDestMode(dest, srcMode, cb);
      });
    });
  }
  function copyDir(src2, dest, opts, cb) {
    fs2.readdir(src2, (err, items) => {
      if (err) return cb(err);
      return copyDirItems(items, src2, dest, opts, cb);
    });
  }
  function copyDirItems(items, src2, dest, opts, cb) {
    const item = items.pop();
    if (!item) return cb();
    return copyDirItem(items, item, src2, dest, opts, cb);
  }
  function copyDirItem(items, item, src2, dest, opts, cb) {
    const srcItem = path.join(src2, item);
    const destItem = path.join(dest, item);
    stat2.checkPaths(srcItem, destItem, "copy", opts, (err, stats) => {
      if (err) return cb(err);
      const { destStat } = stats;
      startCopy(destStat, srcItem, destItem, opts, (err2) => {
        if (err2) return cb(err2);
        return copyDirItems(items, src2, dest, opts, cb);
      });
    });
  }
  function onLink(destStat, src2, dest, opts, cb) {
    fs2.readlink(src2, (err, resolvedSrc) => {
      if (err) return cb(err);
      if (opts.dereference) {
        resolvedSrc = path.resolve(process.cwd(), resolvedSrc);
      }
      if (!destStat) {
        return fs2.symlink(resolvedSrc, dest, cb);
      } else {
        fs2.readlink(dest, (err2, resolvedDest) => {
          if (err2) {
            if (err2.code === "EINVAL" || err2.code === "UNKNOWN") return fs2.symlink(resolvedSrc, dest, cb);
            return cb(err2);
          }
          if (opts.dereference) {
            resolvedDest = path.resolve(process.cwd(), resolvedDest);
          }
          if (stat2.isSrcSubdir(resolvedSrc, resolvedDest)) {
            return cb(new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`));
          }
          if (destStat.isDirectory() && stat2.isSrcSubdir(resolvedDest, resolvedSrc)) {
            return cb(new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`));
          }
          return copyLink(resolvedSrc, dest, cb);
        });
      }
    });
  }
  function copyLink(resolvedSrc, dest, cb) {
    fs2.unlink(dest, (err) => {
      if (err) return cb(err);
      return fs2.symlink(resolvedSrc, dest, cb);
    });
  }
  copy_1$1 = copy2;
  return copy_1$1;
}
var copySync_1$1;
var hasRequiredCopySync$1;
function requireCopySync$1() {
  if (hasRequiredCopySync$1) return copySync_1$1;
  hasRequiredCopySync$1 = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const mkdirsSync = requireMkdirs$1().mkdirsSync;
  const utimesMillisSync = requireUtimes$1().utimesMillisSync;
  const stat2 = /* @__PURE__ */ requireStat$1();
  function copySync(src2, dest, opts) {
    if (typeof opts === "function") {
      opts = { filter: opts };
    }
    opts = opts || {};
    opts.clobber = "clobber" in opts ? !!opts.clobber : true;
    opts.overwrite = "overwrite" in opts ? !!opts.overwrite : opts.clobber;
    if (opts.preserveTimestamps && process.arch === "ia32") {
      process.emitWarning(
        "Using the preserveTimestamps option in 32-bit node is not recommended;\n\n	see https://github.com/jprichardson/node-fs-extra/issues/269",
        "Warning",
        "fs-extra-WARN0002"
      );
    }
    const { srcStat, destStat } = stat2.checkPathsSync(src2, dest, "copy", opts);
    stat2.checkParentPathsSync(src2, srcStat, dest, "copy");
    return handleFilterAndCopy(destStat, src2, dest, opts);
  }
  function handleFilterAndCopy(destStat, src2, dest, opts) {
    if (opts.filter && !opts.filter(src2, dest)) return;
    const destParent = path.dirname(dest);
    if (!fs2.existsSync(destParent)) mkdirsSync(destParent);
    return getStats(destStat, src2, dest, opts);
  }
  function startCopy(destStat, src2, dest, opts) {
    if (opts.filter && !opts.filter(src2, dest)) return;
    return getStats(destStat, src2, dest, opts);
  }
  function getStats(destStat, src2, dest, opts) {
    const statSync = opts.dereference ? fs2.statSync : fs2.lstatSync;
    const srcStat = statSync(src2);
    if (srcStat.isDirectory()) return onDir(srcStat, destStat, src2, dest, opts);
    else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) return onFile(srcStat, destStat, src2, dest, opts);
    else if (srcStat.isSymbolicLink()) return onLink(destStat, src2, dest, opts);
    else if (srcStat.isSocket()) throw new Error(`Cannot copy a socket file: ${src2}`);
    else if (srcStat.isFIFO()) throw new Error(`Cannot copy a FIFO pipe: ${src2}`);
    throw new Error(`Unknown file: ${src2}`);
  }
  function onFile(srcStat, destStat, src2, dest, opts) {
    if (!destStat) return copyFile(srcStat, src2, dest, opts);
    return mayCopyFile(srcStat, src2, dest, opts);
  }
  function mayCopyFile(srcStat, src2, dest, opts) {
    if (opts.overwrite) {
      fs2.unlinkSync(dest);
      return copyFile(srcStat, src2, dest, opts);
    } else if (opts.errorOnExist) {
      throw new Error(`'${dest}' already exists`);
    }
  }
  function copyFile(srcStat, src2, dest, opts) {
    fs2.copyFileSync(src2, dest);
    if (opts.preserveTimestamps) handleTimestamps(srcStat.mode, src2, dest);
    return setDestMode(dest, srcStat.mode);
  }
  function handleTimestamps(srcMode, src2, dest) {
    if (fileIsNotWritable(srcMode)) makeFileWritable(dest, srcMode);
    return setDestTimestamps(src2, dest);
  }
  function fileIsNotWritable(srcMode) {
    return (srcMode & 128) === 0;
  }
  function makeFileWritable(dest, srcMode) {
    return setDestMode(dest, srcMode | 128);
  }
  function setDestMode(dest, srcMode) {
    return fs2.chmodSync(dest, srcMode);
  }
  function setDestTimestamps(src2, dest) {
    const updatedSrcStat = fs2.statSync(src2);
    return utimesMillisSync(dest, updatedSrcStat.atime, updatedSrcStat.mtime);
  }
  function onDir(srcStat, destStat, src2, dest, opts) {
    if (!destStat) return mkDirAndCopy(srcStat.mode, src2, dest, opts);
    return copyDir(src2, dest, opts);
  }
  function mkDirAndCopy(srcMode, src2, dest, opts) {
    fs2.mkdirSync(dest);
    copyDir(src2, dest, opts);
    return setDestMode(dest, srcMode);
  }
  function copyDir(src2, dest, opts) {
    fs2.readdirSync(src2).forEach((item) => copyDirItem(item, src2, dest, opts));
  }
  function copyDirItem(item, src2, dest, opts) {
    const srcItem = path.join(src2, item);
    const destItem = path.join(dest, item);
    const { destStat } = stat2.checkPathsSync(srcItem, destItem, "copy", opts);
    return startCopy(destStat, srcItem, destItem, opts);
  }
  function onLink(destStat, src2, dest, opts) {
    let resolvedSrc = fs2.readlinkSync(src2);
    if (opts.dereference) {
      resolvedSrc = path.resolve(process.cwd(), resolvedSrc);
    }
    if (!destStat) {
      return fs2.symlinkSync(resolvedSrc, dest);
    } else {
      let resolvedDest;
      try {
        resolvedDest = fs2.readlinkSync(dest);
      } catch (err) {
        if (err.code === "EINVAL" || err.code === "UNKNOWN") return fs2.symlinkSync(resolvedSrc, dest);
        throw err;
      }
      if (opts.dereference) {
        resolvedDest = path.resolve(process.cwd(), resolvedDest);
      }
      if (stat2.isSrcSubdir(resolvedSrc, resolvedDest)) {
        throw new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`);
      }
      if (fs2.statSync(dest).isDirectory() && stat2.isSrcSubdir(resolvedDest, resolvedSrc)) {
        throw new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`);
      }
      return copyLink(resolvedSrc, dest);
    }
  }
  function copyLink(resolvedSrc, dest) {
    fs2.unlinkSync(dest);
    return fs2.symlinkSync(resolvedSrc, dest);
  }
  copySync_1$1 = copySync;
  return copySync_1$1;
}
var copy$1;
var hasRequiredCopy$2;
function requireCopy$2() {
  if (hasRequiredCopy$2) return copy$1;
  hasRequiredCopy$2 = 1;
  const u = requireUniversalify().fromCallback;
  copy$1 = {
    copy: u(/* @__PURE__ */ requireCopy$3()),
    copySync: /* @__PURE__ */ requireCopySync$1()
  };
  return copy$1;
}
var rimraf_1$1;
var hasRequiredRimraf$1;
function requireRimraf$1() {
  if (hasRequiredRimraf$1) return rimraf_1$1;
  hasRequiredRimraf$1 = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const assert = require$$2;
  const isWindows = process.platform === "win32";
  function defaults(options) {
    const methods = [
      "unlink",
      "chmod",
      "stat",
      "lstat",
      "rmdir",
      "readdir"
    ];
    methods.forEach((m) => {
      options[m] = options[m] || fs2[m];
      m = m + "Sync";
      options[m] = options[m] || fs2[m];
    });
    options.maxBusyTries = options.maxBusyTries || 3;
  }
  function rimraf(p, options, cb) {
    let busyTries = 0;
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    assert(p, "rimraf: missing path");
    assert.strictEqual(typeof p, "string", "rimraf: path should be a string");
    assert.strictEqual(typeof cb, "function", "rimraf: callback function required");
    assert(options, "rimraf: invalid options argument provided");
    assert.strictEqual(typeof options, "object", "rimraf: options should be object");
    defaults(options);
    rimraf_(p, options, function CB(er) {
      if (er) {
        if ((er.code === "EBUSY" || er.code === "ENOTEMPTY" || er.code === "EPERM") && busyTries < options.maxBusyTries) {
          busyTries++;
          const time = busyTries * 100;
          return setTimeout(() => rimraf_(p, options, CB), time);
        }
        if (er.code === "ENOENT") er = null;
      }
      cb(er);
    });
  }
  function rimraf_(p, options, cb) {
    assert(p);
    assert(options);
    assert(typeof cb === "function");
    options.lstat(p, (er, st) => {
      if (er && er.code === "ENOENT") {
        return cb(null);
      }
      if (er && er.code === "EPERM" && isWindows) {
        return fixWinEPERM(p, options, er, cb);
      }
      if (st && st.isDirectory()) {
        return rmdir(p, options, er, cb);
      }
      options.unlink(p, (er2) => {
        if (er2) {
          if (er2.code === "ENOENT") {
            return cb(null);
          }
          if (er2.code === "EPERM") {
            return isWindows ? fixWinEPERM(p, options, er2, cb) : rmdir(p, options, er2, cb);
          }
          if (er2.code === "EISDIR") {
            return rmdir(p, options, er2, cb);
          }
        }
        return cb(er2);
      });
    });
  }
  function fixWinEPERM(p, options, er, cb) {
    assert(p);
    assert(options);
    assert(typeof cb === "function");
    options.chmod(p, 438, (er2) => {
      if (er2) {
        cb(er2.code === "ENOENT" ? null : er);
      } else {
        options.stat(p, (er3, stats) => {
          if (er3) {
            cb(er3.code === "ENOENT" ? null : er);
          } else if (stats.isDirectory()) {
            rmdir(p, options, er, cb);
          } else {
            options.unlink(p, cb);
          }
        });
      }
    });
  }
  function fixWinEPERMSync(p, options, er) {
    let stats;
    assert(p);
    assert(options);
    try {
      options.chmodSync(p, 438);
    } catch (er2) {
      if (er2.code === "ENOENT") {
        return;
      } else {
        throw er;
      }
    }
    try {
      stats = options.statSync(p);
    } catch (er3) {
      if (er3.code === "ENOENT") {
        return;
      } else {
        throw er;
      }
    }
    if (stats.isDirectory()) {
      rmdirSync(p, options, er);
    } else {
      options.unlinkSync(p);
    }
  }
  function rmdir(p, options, originalEr, cb) {
    assert(p);
    assert(options);
    assert(typeof cb === "function");
    options.rmdir(p, (er) => {
      if (er && (er.code === "ENOTEMPTY" || er.code === "EEXIST" || er.code === "EPERM")) {
        rmkids(p, options, cb);
      } else if (er && er.code === "ENOTDIR") {
        cb(originalEr);
      } else {
        cb(er);
      }
    });
  }
  function rmkids(p, options, cb) {
    assert(p);
    assert(options);
    assert(typeof cb === "function");
    options.readdir(p, (er, files) => {
      if (er) return cb(er);
      let n = files.length;
      let errState;
      if (n === 0) return options.rmdir(p, cb);
      files.forEach((f) => {
        rimraf(path.join(p, f), options, (er2) => {
          if (errState) {
            return;
          }
          if (er2) return cb(errState = er2);
          if (--n === 0) {
            options.rmdir(p, cb);
          }
        });
      });
    });
  }
  function rimrafSync(p, options) {
    let st;
    options = options || {};
    defaults(options);
    assert(p, "rimraf: missing path");
    assert.strictEqual(typeof p, "string", "rimraf: path should be a string");
    assert(options, "rimraf: missing options");
    assert.strictEqual(typeof options, "object", "rimraf: options should be object");
    try {
      st = options.lstatSync(p);
    } catch (er) {
      if (er.code === "ENOENT") {
        return;
      }
      if (er.code === "EPERM" && isWindows) {
        fixWinEPERMSync(p, options, er);
      }
    }
    try {
      if (st && st.isDirectory()) {
        rmdirSync(p, options, null);
      } else {
        options.unlinkSync(p);
      }
    } catch (er) {
      if (er.code === "ENOENT") {
        return;
      } else if (er.code === "EPERM") {
        return isWindows ? fixWinEPERMSync(p, options, er) : rmdirSync(p, options, er);
      } else if (er.code !== "EISDIR") {
        throw er;
      }
      rmdirSync(p, options, er);
    }
  }
  function rmdirSync(p, options, originalEr) {
    assert(p);
    assert(options);
    try {
      options.rmdirSync(p);
    } catch (er) {
      if (er.code === "ENOTDIR") {
        throw originalEr;
      } else if (er.code === "ENOTEMPTY" || er.code === "EEXIST" || er.code === "EPERM") {
        rmkidsSync(p, options);
      } else if (er.code !== "ENOENT") {
        throw er;
      }
    }
  }
  function rmkidsSync(p, options) {
    assert(p);
    assert(options);
    options.readdirSync(p).forEach((f) => rimrafSync(path.join(p, f), options));
    if (isWindows) {
      const startTime = Date.now();
      do {
        try {
          const ret = options.rmdirSync(p, options);
          return ret;
        } catch {
        }
      } while (Date.now() - startTime < 500);
    } else {
      const ret = options.rmdirSync(p, options);
      return ret;
    }
  }
  rimraf_1$1 = rimraf;
  rimraf.sync = rimrafSync;
  return rimraf_1$1;
}
var remove_1$1;
var hasRequiredRemove$1;
function requireRemove$1() {
  if (hasRequiredRemove$1) return remove_1$1;
  hasRequiredRemove$1 = 1;
  const fs2 = requireGracefulFs();
  const u = requireUniversalify().fromCallback;
  const rimraf = /* @__PURE__ */ requireRimraf$1();
  function remove(path, callback) {
    if (fs2.rm) return fs2.rm(path, { recursive: true, force: true }, callback);
    rimraf(path, callback);
  }
  function removeSync(path) {
    if (fs2.rmSync) return fs2.rmSync(path, { recursive: true, force: true });
    rimraf.sync(path);
  }
  remove_1$1 = {
    remove: u(remove),
    removeSync
  };
  return remove_1$1;
}
var empty$1;
var hasRequiredEmpty$1;
function requireEmpty$1() {
  if (hasRequiredEmpty$1) return empty$1;
  hasRequiredEmpty$1 = 1;
  const u = requireUniversalify().fromPromise;
  const fs2 = /* @__PURE__ */ requireFs$1();
  const path = require$$1;
  const mkdir = /* @__PURE__ */ requireMkdirs$1();
  const remove = /* @__PURE__ */ requireRemove$1();
  const emptyDir = u(async function emptyDir2(dir) {
    let items;
    try {
      items = await fs2.readdir(dir);
    } catch {
      return mkdir.mkdirs(dir);
    }
    return Promise.all(items.map((item) => remove.remove(path.join(dir, item))));
  });
  function emptyDirSync(dir) {
    let items;
    try {
      items = fs2.readdirSync(dir);
    } catch {
      return mkdir.mkdirsSync(dir);
    }
    items.forEach((item) => {
      item = path.join(dir, item);
      remove.removeSync(item);
    });
  }
  empty$1 = {
    emptyDirSync,
    emptydirSync: emptyDirSync,
    emptyDir,
    emptydir: emptyDir
  };
  return empty$1;
}
var file$1;
var hasRequiredFile$1;
function requireFile$1() {
  if (hasRequiredFile$1) return file$1;
  hasRequiredFile$1 = 1;
  const u = requireUniversalify().fromCallback;
  const path = require$$1;
  const fs2 = requireGracefulFs();
  const mkdir = /* @__PURE__ */ requireMkdirs$1();
  function createFile(file2, callback) {
    function makeFile() {
      fs2.writeFile(file2, "", (err) => {
        if (err) return callback(err);
        callback();
      });
    }
    fs2.stat(file2, (err, stats) => {
      if (!err && stats.isFile()) return callback();
      const dir = path.dirname(file2);
      fs2.stat(dir, (err2, stats2) => {
        if (err2) {
          if (err2.code === "ENOENT") {
            return mkdir.mkdirs(dir, (err3) => {
              if (err3) return callback(err3);
              makeFile();
            });
          }
          return callback(err2);
        }
        if (stats2.isDirectory()) makeFile();
        else {
          fs2.readdir(dir, (err3) => {
            if (err3) return callback(err3);
          });
        }
      });
    });
  }
  function createFileSync(file2) {
    let stats;
    try {
      stats = fs2.statSync(file2);
    } catch {
    }
    if (stats && stats.isFile()) return;
    const dir = path.dirname(file2);
    try {
      if (!fs2.statSync(dir).isDirectory()) {
        fs2.readdirSync(dir);
      }
    } catch (err) {
      if (err && err.code === "ENOENT") mkdir.mkdirsSync(dir);
      else throw err;
    }
    fs2.writeFileSync(file2, "");
  }
  file$1 = {
    createFile: u(createFile),
    createFileSync
  };
  return file$1;
}
var link$1;
var hasRequiredLink$1;
function requireLink$1() {
  if (hasRequiredLink$1) return link$1;
  hasRequiredLink$1 = 1;
  const u = requireUniversalify().fromCallback;
  const path = require$$1;
  const fs2 = requireGracefulFs();
  const mkdir = /* @__PURE__ */ requireMkdirs$1();
  const pathExists = requirePathExists$1().pathExists;
  const { areIdentical } = /* @__PURE__ */ requireStat$1();
  function createLink(srcpath, dstpath, callback) {
    function makeLink(srcpath2, dstpath2) {
      fs2.link(srcpath2, dstpath2, (err) => {
        if (err) return callback(err);
        callback(null);
      });
    }
    fs2.lstat(dstpath, (_, dstStat) => {
      fs2.lstat(srcpath, (err, srcStat) => {
        if (err) {
          err.message = err.message.replace("lstat", "ensureLink");
          return callback(err);
        }
        if (dstStat && areIdentical(srcStat, dstStat)) return callback(null);
        const dir = path.dirname(dstpath);
        pathExists(dir, (err2, dirExists) => {
          if (err2) return callback(err2);
          if (dirExists) return makeLink(srcpath, dstpath);
          mkdir.mkdirs(dir, (err3) => {
            if (err3) return callback(err3);
            makeLink(srcpath, dstpath);
          });
        });
      });
    });
  }
  function createLinkSync(srcpath, dstpath) {
    let dstStat;
    try {
      dstStat = fs2.lstatSync(dstpath);
    } catch {
    }
    try {
      const srcStat = fs2.lstatSync(srcpath);
      if (dstStat && areIdentical(srcStat, dstStat)) return;
    } catch (err) {
      err.message = err.message.replace("lstat", "ensureLink");
      throw err;
    }
    const dir = path.dirname(dstpath);
    const dirExists = fs2.existsSync(dir);
    if (dirExists) return fs2.linkSync(srcpath, dstpath);
    mkdir.mkdirsSync(dir);
    return fs2.linkSync(srcpath, dstpath);
  }
  link$1 = {
    createLink: u(createLink),
    createLinkSync
  };
  return link$1;
}
var symlinkPaths_1$1;
var hasRequiredSymlinkPaths$1;
function requireSymlinkPaths$1() {
  if (hasRequiredSymlinkPaths$1) return symlinkPaths_1$1;
  hasRequiredSymlinkPaths$1 = 1;
  const path = require$$1;
  const fs2 = requireGracefulFs();
  const pathExists = requirePathExists$1().pathExists;
  function symlinkPaths(srcpath, dstpath, callback) {
    if (path.isAbsolute(srcpath)) {
      return fs2.lstat(srcpath, (err) => {
        if (err) {
          err.message = err.message.replace("lstat", "ensureSymlink");
          return callback(err);
        }
        return callback(null, {
          toCwd: srcpath,
          toDst: srcpath
        });
      });
    } else {
      const dstdir = path.dirname(dstpath);
      const relativeToDst = path.join(dstdir, srcpath);
      return pathExists(relativeToDst, (err, exists) => {
        if (err) return callback(err);
        if (exists) {
          return callback(null, {
            toCwd: relativeToDst,
            toDst: srcpath
          });
        } else {
          return fs2.lstat(srcpath, (err2) => {
            if (err2) {
              err2.message = err2.message.replace("lstat", "ensureSymlink");
              return callback(err2);
            }
            return callback(null, {
              toCwd: srcpath,
              toDst: path.relative(dstdir, srcpath)
            });
          });
        }
      });
    }
  }
  function symlinkPathsSync(srcpath, dstpath) {
    let exists;
    if (path.isAbsolute(srcpath)) {
      exists = fs2.existsSync(srcpath);
      if (!exists) throw new Error("absolute srcpath does not exist");
      return {
        toCwd: srcpath,
        toDst: srcpath
      };
    } else {
      const dstdir = path.dirname(dstpath);
      const relativeToDst = path.join(dstdir, srcpath);
      exists = fs2.existsSync(relativeToDst);
      if (exists) {
        return {
          toCwd: relativeToDst,
          toDst: srcpath
        };
      } else {
        exists = fs2.existsSync(srcpath);
        if (!exists) throw new Error("relative srcpath does not exist");
        return {
          toCwd: srcpath,
          toDst: path.relative(dstdir, srcpath)
        };
      }
    }
  }
  symlinkPaths_1$1 = {
    symlinkPaths,
    symlinkPathsSync
  };
  return symlinkPaths_1$1;
}
var symlinkType_1$1;
var hasRequiredSymlinkType$1;
function requireSymlinkType$1() {
  if (hasRequiredSymlinkType$1) return symlinkType_1$1;
  hasRequiredSymlinkType$1 = 1;
  const fs2 = requireGracefulFs();
  function symlinkType(srcpath, type, callback) {
    callback = typeof type === "function" ? type : callback;
    type = typeof type === "function" ? false : type;
    if (type) return callback(null, type);
    fs2.lstat(srcpath, (err, stats) => {
      if (err) return callback(null, "file");
      type = stats && stats.isDirectory() ? "dir" : "file";
      callback(null, type);
    });
  }
  function symlinkTypeSync(srcpath, type) {
    let stats;
    if (type) return type;
    try {
      stats = fs2.lstatSync(srcpath);
    } catch {
      return "file";
    }
    return stats && stats.isDirectory() ? "dir" : "file";
  }
  symlinkType_1$1 = {
    symlinkType,
    symlinkTypeSync
  };
  return symlinkType_1$1;
}
var symlink$1;
var hasRequiredSymlink$1;
function requireSymlink$1() {
  if (hasRequiredSymlink$1) return symlink$1;
  hasRequiredSymlink$1 = 1;
  const u = requireUniversalify().fromCallback;
  const path = require$$1;
  const fs2 = /* @__PURE__ */ requireFs$1();
  const _mkdirs = /* @__PURE__ */ requireMkdirs$1();
  const mkdirs2 = _mkdirs.mkdirs;
  const mkdirsSync = _mkdirs.mkdirsSync;
  const _symlinkPaths = /* @__PURE__ */ requireSymlinkPaths$1();
  const symlinkPaths = _symlinkPaths.symlinkPaths;
  const symlinkPathsSync = _symlinkPaths.symlinkPathsSync;
  const _symlinkType = /* @__PURE__ */ requireSymlinkType$1();
  const symlinkType = _symlinkType.symlinkType;
  const symlinkTypeSync = _symlinkType.symlinkTypeSync;
  const pathExists = requirePathExists$1().pathExists;
  const { areIdentical } = /* @__PURE__ */ requireStat$1();
  function createSymlink(srcpath, dstpath, type, callback) {
    callback = typeof type === "function" ? type : callback;
    type = typeof type === "function" ? false : type;
    fs2.lstat(dstpath, (err, stats) => {
      if (!err && stats.isSymbolicLink()) {
        Promise.all([
          fs2.stat(srcpath),
          fs2.stat(dstpath)
        ]).then(([srcStat, dstStat]) => {
          if (areIdentical(srcStat, dstStat)) return callback(null);
          _createSymlink(srcpath, dstpath, type, callback);
        });
      } else _createSymlink(srcpath, dstpath, type, callback);
    });
  }
  function _createSymlink(srcpath, dstpath, type, callback) {
    symlinkPaths(srcpath, dstpath, (err, relative) => {
      if (err) return callback(err);
      srcpath = relative.toDst;
      symlinkType(relative.toCwd, type, (err2, type2) => {
        if (err2) return callback(err2);
        const dir = path.dirname(dstpath);
        pathExists(dir, (err3, dirExists) => {
          if (err3) return callback(err3);
          if (dirExists) return fs2.symlink(srcpath, dstpath, type2, callback);
          mkdirs2(dir, (err4) => {
            if (err4) return callback(err4);
            fs2.symlink(srcpath, dstpath, type2, callback);
          });
        });
      });
    });
  }
  function createSymlinkSync(srcpath, dstpath, type) {
    let stats;
    try {
      stats = fs2.lstatSync(dstpath);
    } catch {
    }
    if (stats && stats.isSymbolicLink()) {
      const srcStat = fs2.statSync(srcpath);
      const dstStat = fs2.statSync(dstpath);
      if (areIdentical(srcStat, dstStat)) return;
    }
    const relative = symlinkPathsSync(srcpath, dstpath);
    srcpath = relative.toDst;
    type = symlinkTypeSync(relative.toCwd, type);
    const dir = path.dirname(dstpath);
    const exists = fs2.existsSync(dir);
    if (exists) return fs2.symlinkSync(srcpath, dstpath, type);
    mkdirsSync(dir);
    return fs2.symlinkSync(srcpath, dstpath, type);
  }
  symlink$1 = {
    createSymlink: u(createSymlink),
    createSymlinkSync
  };
  return symlink$1;
}
var ensure$1;
var hasRequiredEnsure$1;
function requireEnsure$1() {
  if (hasRequiredEnsure$1) return ensure$1;
  hasRequiredEnsure$1 = 1;
  const { createFile, createFileSync } = /* @__PURE__ */ requireFile$1();
  const { createLink, createLinkSync } = /* @__PURE__ */ requireLink$1();
  const { createSymlink, createSymlinkSync } = /* @__PURE__ */ requireSymlink$1();
  ensure$1 = {
    // file
    createFile,
    createFileSync,
    ensureFile: createFile,
    ensureFileSync: createFileSync,
    // link
    createLink,
    createLinkSync,
    ensureLink: createLink,
    ensureLinkSync: createLinkSync,
    // symlink
    createSymlink,
    createSymlinkSync,
    ensureSymlink: createSymlink,
    ensureSymlinkSync: createSymlinkSync
  };
  return ensure$1;
}
var utils$1;
var hasRequiredUtils$1;
function requireUtils$1() {
  if (hasRequiredUtils$1) return utils$1;
  hasRequiredUtils$1 = 1;
  function stringify(obj, { EOL = "\n", finalEOL = true, replacer = null, spaces } = {}) {
    const EOF = finalEOL ? EOL : "";
    const str = JSON.stringify(obj, replacer, spaces);
    return str.replace(/\n/g, EOL) + EOF;
  }
  function stripBom(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    return content.replace(/^\uFEFF/, "");
  }
  utils$1 = { stringify, stripBom };
  return utils$1;
}
var jsonfile_1;
var hasRequiredJsonfile$2;
function requireJsonfile$2() {
  if (hasRequiredJsonfile$2) return jsonfile_1;
  hasRequiredJsonfile$2 = 1;
  let _fs;
  try {
    _fs = requireGracefulFs();
  } catch (_) {
    _fs = require$$0$2;
  }
  const universalify2 = requireUniversalify();
  const { stringify, stripBom } = requireUtils$1();
  async function _readFile(file2, options = {}) {
    if (typeof options === "string") {
      options = { encoding: options };
    }
    const fs2 = options.fs || _fs;
    const shouldThrow = "throws" in options ? options.throws : true;
    let data = await universalify2.fromCallback(fs2.readFile)(file2, options);
    data = stripBom(data);
    let obj;
    try {
      obj = JSON.parse(data, options ? options.reviver : null);
    } catch (err) {
      if (shouldThrow) {
        err.message = `${file2}: ${err.message}`;
        throw err;
      } else {
        return null;
      }
    }
    return obj;
  }
  const readFile = universalify2.fromPromise(_readFile);
  function readFileSync(file2, options = {}) {
    if (typeof options === "string") {
      options = { encoding: options };
    }
    const fs2 = options.fs || _fs;
    const shouldThrow = "throws" in options ? options.throws : true;
    try {
      let content = fs2.readFileSync(file2, options);
      content = stripBom(content);
      return JSON.parse(content, options.reviver);
    } catch (err) {
      if (shouldThrow) {
        err.message = `${file2}: ${err.message}`;
        throw err;
      } else {
        return null;
      }
    }
  }
  async function _writeFile(file2, obj, options = {}) {
    const fs2 = options.fs || _fs;
    const str = stringify(obj, options);
    await universalify2.fromCallback(fs2.writeFile)(file2, str, options);
  }
  const writeFile = universalify2.fromPromise(_writeFile);
  function writeFileSync(file2, obj, options = {}) {
    const fs2 = options.fs || _fs;
    const str = stringify(obj, options);
    return fs2.writeFileSync(file2, str, options);
  }
  const jsonfile2 = {
    readFile,
    readFileSync,
    writeFile,
    writeFileSync
  };
  jsonfile_1 = jsonfile2;
  return jsonfile_1;
}
var jsonfile$1;
var hasRequiredJsonfile$1;
function requireJsonfile$1() {
  if (hasRequiredJsonfile$1) return jsonfile$1;
  hasRequiredJsonfile$1 = 1;
  const jsonFile = requireJsonfile$2();
  jsonfile$1 = {
    // jsonfile exports
    readJson: jsonFile.readFile,
    readJsonSync: jsonFile.readFileSync,
    writeJson: jsonFile.writeFile,
    writeJsonSync: jsonFile.writeFileSync
  };
  return jsonfile$1;
}
var outputFile_1$1;
var hasRequiredOutputFile$1;
function requireOutputFile$1() {
  if (hasRequiredOutputFile$1) return outputFile_1$1;
  hasRequiredOutputFile$1 = 1;
  const u = requireUniversalify().fromCallback;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const mkdir = /* @__PURE__ */ requireMkdirs$1();
  const pathExists = requirePathExists$1().pathExists;
  function outputFile(file2, data, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = "utf8";
    }
    const dir = path.dirname(file2);
    pathExists(dir, (err, itDoes) => {
      if (err) return callback(err);
      if (itDoes) return fs2.writeFile(file2, data, encoding, callback);
      mkdir.mkdirs(dir, (err2) => {
        if (err2) return callback(err2);
        fs2.writeFile(file2, data, encoding, callback);
      });
    });
  }
  function outputFileSync(file2, ...args) {
    const dir = path.dirname(file2);
    if (fs2.existsSync(dir)) {
      return fs2.writeFileSync(file2, ...args);
    }
    mkdir.mkdirsSync(dir);
    fs2.writeFileSync(file2, ...args);
  }
  outputFile_1$1 = {
    outputFile: u(outputFile),
    outputFileSync
  };
  return outputFile_1$1;
}
var outputJson_1$1;
var hasRequiredOutputJson$1;
function requireOutputJson$1() {
  if (hasRequiredOutputJson$1) return outputJson_1$1;
  hasRequiredOutputJson$1 = 1;
  const { stringify } = requireUtils$1();
  const { outputFile } = /* @__PURE__ */ requireOutputFile$1();
  async function outputJson(file2, data, options = {}) {
    const str = stringify(data, options);
    await outputFile(file2, str, options);
  }
  outputJson_1$1 = outputJson;
  return outputJson_1$1;
}
var outputJsonSync_1$1;
var hasRequiredOutputJsonSync$1;
function requireOutputJsonSync$1() {
  if (hasRequiredOutputJsonSync$1) return outputJsonSync_1$1;
  hasRequiredOutputJsonSync$1 = 1;
  const { stringify } = requireUtils$1();
  const { outputFileSync } = /* @__PURE__ */ requireOutputFile$1();
  function outputJsonSync(file2, data, options) {
    const str = stringify(data, options);
    outputFileSync(file2, str, options);
  }
  outputJsonSync_1$1 = outputJsonSync;
  return outputJsonSync_1$1;
}
var json$1;
var hasRequiredJson$1;
function requireJson$1() {
  if (hasRequiredJson$1) return json$1;
  hasRequiredJson$1 = 1;
  const u = requireUniversalify().fromPromise;
  const jsonFile = /* @__PURE__ */ requireJsonfile$1();
  jsonFile.outputJson = u(/* @__PURE__ */ requireOutputJson$1());
  jsonFile.outputJsonSync = /* @__PURE__ */ requireOutputJsonSync$1();
  jsonFile.outputJSON = jsonFile.outputJson;
  jsonFile.outputJSONSync = jsonFile.outputJsonSync;
  jsonFile.writeJSON = jsonFile.writeJson;
  jsonFile.writeJSONSync = jsonFile.writeJsonSync;
  jsonFile.readJSON = jsonFile.readJson;
  jsonFile.readJSONSync = jsonFile.readJsonSync;
  json$1 = jsonFile;
  return json$1;
}
var move_1$1;
var hasRequiredMove$3;
function requireMove$3() {
  if (hasRequiredMove$3) return move_1$1;
  hasRequiredMove$3 = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const copy2 = requireCopy$2().copy;
  const remove = requireRemove$1().remove;
  const mkdirp = requireMkdirs$1().mkdirp;
  const pathExists = requirePathExists$1().pathExists;
  const stat2 = /* @__PURE__ */ requireStat$1();
  function move2(src2, dest, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    const overwrite = opts.overwrite || opts.clobber || false;
    stat2.checkPaths(src2, dest, "move", opts, (err, stats) => {
      if (err) return cb(err);
      const { srcStat, isChangingCase = false } = stats;
      stat2.checkParentPaths(src2, srcStat, dest, "move", (err2) => {
        if (err2) return cb(err2);
        if (isParentRoot(dest)) return doRename(src2, dest, overwrite, isChangingCase, cb);
        mkdirp(path.dirname(dest), (err3) => {
          if (err3) return cb(err3);
          return doRename(src2, dest, overwrite, isChangingCase, cb);
        });
      });
    });
  }
  function isParentRoot(dest) {
    const parent = path.dirname(dest);
    const parsedPath = path.parse(parent);
    return parsedPath.root === parent;
  }
  function doRename(src2, dest, overwrite, isChangingCase, cb) {
    if (isChangingCase) return rename(src2, dest, overwrite, cb);
    if (overwrite) {
      return remove(dest, (err) => {
        if (err) return cb(err);
        return rename(src2, dest, overwrite, cb);
      });
    }
    pathExists(dest, (err, destExists) => {
      if (err) return cb(err);
      if (destExists) return cb(new Error("dest already exists."));
      return rename(src2, dest, overwrite, cb);
    });
  }
  function rename(src2, dest, overwrite, cb) {
    fs2.rename(src2, dest, (err) => {
      if (!err) return cb();
      if (err.code !== "EXDEV") return cb(err);
      return moveAcrossDevice(src2, dest, overwrite, cb);
    });
  }
  function moveAcrossDevice(src2, dest, overwrite, cb) {
    const opts = {
      overwrite,
      errorOnExist: true
    };
    copy2(src2, dest, opts, (err) => {
      if (err) return cb(err);
      return remove(src2, cb);
    });
  }
  move_1$1 = move2;
  return move_1$1;
}
var moveSync_1$1;
var hasRequiredMoveSync$1;
function requireMoveSync$1() {
  if (hasRequiredMoveSync$1) return moveSync_1$1;
  hasRequiredMoveSync$1 = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const copySync = requireCopy$2().copySync;
  const removeSync = requireRemove$1().removeSync;
  const mkdirpSync = requireMkdirs$1().mkdirpSync;
  const stat2 = /* @__PURE__ */ requireStat$1();
  function moveSync(src2, dest, opts) {
    opts = opts || {};
    const overwrite = opts.overwrite || opts.clobber || false;
    const { srcStat, isChangingCase = false } = stat2.checkPathsSync(src2, dest, "move", opts);
    stat2.checkParentPathsSync(src2, srcStat, dest, "move");
    if (!isParentRoot(dest)) mkdirpSync(path.dirname(dest));
    return doRename(src2, dest, overwrite, isChangingCase);
  }
  function isParentRoot(dest) {
    const parent = path.dirname(dest);
    const parsedPath = path.parse(parent);
    return parsedPath.root === parent;
  }
  function doRename(src2, dest, overwrite, isChangingCase) {
    if (isChangingCase) return rename(src2, dest, overwrite);
    if (overwrite) {
      removeSync(dest);
      return rename(src2, dest, overwrite);
    }
    if (fs2.existsSync(dest)) throw new Error("dest already exists.");
    return rename(src2, dest, overwrite);
  }
  function rename(src2, dest, overwrite) {
    try {
      fs2.renameSync(src2, dest);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      return moveAcrossDevice(src2, dest, overwrite);
    }
  }
  function moveAcrossDevice(src2, dest, overwrite) {
    const opts = {
      overwrite,
      errorOnExist: true
    };
    copySync(src2, dest, opts);
    return removeSync(src2);
  }
  moveSync_1$1 = moveSync;
  return moveSync_1$1;
}
var move$1;
var hasRequiredMove$2;
function requireMove$2() {
  if (hasRequiredMove$2) return move$1;
  hasRequiredMove$2 = 1;
  const u = requireUniversalify().fromCallback;
  move$1 = {
    move: u(/* @__PURE__ */ requireMove$3()),
    moveSync: /* @__PURE__ */ requireMoveSync$1()
  };
  return move$1;
}
var lib$3;
var hasRequiredLib$4;
function requireLib$4() {
  if (hasRequiredLib$4) return lib$3;
  hasRequiredLib$4 = 1;
  lib$3 = {
    // Export promiseified graceful-fs:
    .../* @__PURE__ */ requireFs$1(),
    // Export extra methods:
    .../* @__PURE__ */ requireCopy$2(),
    .../* @__PURE__ */ requireEmpty$1(),
    .../* @__PURE__ */ requireEnsure$1(),
    .../* @__PURE__ */ requireJson$1(),
    .../* @__PURE__ */ requireMkdirs$1(),
    .../* @__PURE__ */ requireMove$2(),
    .../* @__PURE__ */ requireOutputFile$1(),
    .../* @__PURE__ */ requirePathExists$1(),
    .../* @__PURE__ */ requireRemove$1()
  };
  return lib$3;
}
var lib$2 = {};
var Walker = {};
var src = { exports: {} };
var browser = { exports: {} };
var ms;
var hasRequiredMs;
function requireMs() {
  if (hasRequiredMs) return ms;
  hasRequiredMs = 1;
  var s = 1e3;
  var m = s * 60;
  var h = m * 60;
  var d = h * 24;
  var w = d * 7;
  var y = d * 365.25;
  ms = function(val, options) {
    options = options || {};
    var type = typeof val;
    if (type === "string" && val.length > 0) {
      return parse(val);
    } else if (type === "number" && isFinite(val)) {
      return options.long ? fmtLong(val) : fmtShort(val);
    }
    throw new Error(
      "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
    );
  };
  function parse(str) {
    str = String(str);
    if (str.length > 100) {
      return;
    }
    var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
      str
    );
    if (!match) {
      return;
    }
    var n = parseFloat(match[1]);
    var type = (match[2] || "ms").toLowerCase();
    switch (type) {
      case "years":
      case "year":
      case "yrs":
      case "yr":
      case "y":
        return n * y;
      case "weeks":
      case "week":
      case "w":
        return n * w;
      case "days":
      case "day":
      case "d":
        return n * d;
      case "hours":
      case "hour":
      case "hrs":
      case "hr":
      case "h":
        return n * h;
      case "minutes":
      case "minute":
      case "mins":
      case "min":
      case "m":
        return n * m;
      case "seconds":
      case "second":
      case "secs":
      case "sec":
      case "s":
        return n * s;
      case "milliseconds":
      case "millisecond":
      case "msecs":
      case "msec":
      case "ms":
        return n;
      default:
        return void 0;
    }
  }
  function fmtShort(ms2) {
    var msAbs = Math.abs(ms2);
    if (msAbs >= d) {
      return Math.round(ms2 / d) + "d";
    }
    if (msAbs >= h) {
      return Math.round(ms2 / h) + "h";
    }
    if (msAbs >= m) {
      return Math.round(ms2 / m) + "m";
    }
    if (msAbs >= s) {
      return Math.round(ms2 / s) + "s";
    }
    return ms2 + "ms";
  }
  function fmtLong(ms2) {
    var msAbs = Math.abs(ms2);
    if (msAbs >= d) {
      return plural(ms2, msAbs, d, "day");
    }
    if (msAbs >= h) {
      return plural(ms2, msAbs, h, "hour");
    }
    if (msAbs >= m) {
      return plural(ms2, msAbs, m, "minute");
    }
    if (msAbs >= s) {
      return plural(ms2, msAbs, s, "second");
    }
    return ms2 + " ms";
  }
  function plural(ms2, msAbs, n, name) {
    var isPlural = msAbs >= n * 1.5;
    return Math.round(ms2 / n) + " " + name + (isPlural ? "s" : "");
  }
  return ms;
}
var common;
var hasRequiredCommon;
function requireCommon() {
  if (hasRequiredCommon) return common;
  hasRequiredCommon = 1;
  function setup(env) {
    createDebug.debug = createDebug;
    createDebug.default = createDebug;
    createDebug.coerce = coerce;
    createDebug.disable = disable;
    createDebug.enable = enable;
    createDebug.enabled = enabled;
    createDebug.humanize = requireMs();
    createDebug.destroy = destroy;
    Object.keys(env).forEach((key) => {
      createDebug[key] = env[key];
    });
    createDebug.names = [];
    createDebug.skips = [];
    createDebug.formatters = {};
    function selectColor(namespace) {
      let hash = 0;
      for (let i = 0; i < namespace.length; i++) {
        hash = (hash << 5) - hash + namespace.charCodeAt(i);
        hash |= 0;
      }
      return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
    }
    createDebug.selectColor = selectColor;
    function createDebug(namespace) {
      let prevTime;
      let enableOverride = null;
      let namespacesCache;
      let enabledCache;
      function debug(...args) {
        if (!debug.enabled) {
          return;
        }
        const self2 = debug;
        const curr = Number(/* @__PURE__ */ new Date());
        const ms2 = curr - (prevTime || curr);
        self2.diff = ms2;
        self2.prev = prevTime;
        self2.curr = curr;
        prevTime = curr;
        args[0] = createDebug.coerce(args[0]);
        if (typeof args[0] !== "string") {
          args.unshift("%O");
        }
        let index = 0;
        args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
          if (match === "%%") {
            return "%";
          }
          index++;
          const formatter = createDebug.formatters[format];
          if (typeof formatter === "function") {
            const val = args[index];
            match = formatter.call(self2, val);
            args.splice(index, 1);
            index--;
          }
          return match;
        });
        createDebug.formatArgs.call(self2, args);
        const logFn = self2.log || createDebug.log;
        logFn.apply(self2, args);
      }
      debug.namespace = namespace;
      debug.useColors = createDebug.useColors();
      debug.color = createDebug.selectColor(namespace);
      debug.extend = extend;
      debug.destroy = createDebug.destroy;
      Object.defineProperty(debug, "enabled", {
        enumerable: true,
        configurable: false,
        get: () => {
          if (enableOverride !== null) {
            return enableOverride;
          }
          if (namespacesCache !== createDebug.namespaces) {
            namespacesCache = createDebug.namespaces;
            enabledCache = createDebug.enabled(namespace);
          }
          return enabledCache;
        },
        set: (v) => {
          enableOverride = v;
        }
      });
      if (typeof createDebug.init === "function") {
        createDebug.init(debug);
      }
      return debug;
    }
    function extend(namespace, delimiter) {
      const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
      newDebug.log = this.log;
      return newDebug;
    }
    function enable(namespaces) {
      createDebug.save(namespaces);
      createDebug.namespaces = namespaces;
      createDebug.names = [];
      createDebug.skips = [];
      const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
      for (const ns of split) {
        if (ns[0] === "-") {
          createDebug.skips.push(ns.slice(1));
        } else {
          createDebug.names.push(ns);
        }
      }
    }
    function matchesTemplate(search, template) {
      let searchIndex = 0;
      let templateIndex = 0;
      let starIndex = -1;
      let matchIndex = 0;
      while (searchIndex < search.length) {
        if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
          if (template[templateIndex] === "*") {
            starIndex = templateIndex;
            matchIndex = searchIndex;
            templateIndex++;
          } else {
            searchIndex++;
            templateIndex++;
          }
        } else if (starIndex !== -1) {
          templateIndex = starIndex + 1;
          matchIndex++;
          searchIndex = matchIndex;
        } else {
          return false;
        }
      }
      while (templateIndex < template.length && template[templateIndex] === "*") {
        templateIndex++;
      }
      return templateIndex === template.length;
    }
    function disable() {
      const namespaces = [
        ...createDebug.names,
        ...createDebug.skips.map((namespace) => "-" + namespace)
      ].join(",");
      createDebug.enable("");
      return namespaces;
    }
    function enabled(name) {
      for (const skip of createDebug.skips) {
        if (matchesTemplate(name, skip)) {
          return false;
        }
      }
      for (const ns of createDebug.names) {
        if (matchesTemplate(name, ns)) {
          return true;
        }
      }
      return false;
    }
    function coerce(val) {
      if (val instanceof Error) {
        return val.stack || val.message;
      }
      return val;
    }
    function destroy() {
      console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
    }
    createDebug.enable(createDebug.load());
    return createDebug;
  }
  common = setup;
  return common;
}
var hasRequiredBrowser;
function requireBrowser() {
  if (hasRequiredBrowser) return browser.exports;
  hasRequiredBrowser = 1;
  (function(module2, exports$1) {
    exports$1.formatArgs = formatArgs;
    exports$1.save = save;
    exports$1.load = load;
    exports$1.useColors = useColors;
    exports$1.storage = localstorage();
    exports$1.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports$1.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module2.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports$1.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports$1.storage.setItem("debug", namespaces);
        } else {
          exports$1.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      let r;
      try {
        r = exports$1.storage.getItem("debug") || exports$1.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module2.exports = requireCommon()(exports$1);
    const { formatters } = module2.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  })(browser, browser.exports);
  return browser.exports;
}
var node = { exports: {} };
var hasFlag;
var hasRequiredHasFlag;
function requireHasFlag() {
  if (hasRequiredHasFlag) return hasFlag;
  hasRequiredHasFlag = 1;
  hasFlag = (flag, argv = process.argv) => {
    const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
    const position = argv.indexOf(prefix + flag);
    const terminatorPosition = argv.indexOf("--");
    return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
  };
  return hasFlag;
}
var supportsColor_1;
var hasRequiredSupportsColor;
function requireSupportsColor() {
  if (hasRequiredSupportsColor) return supportsColor_1;
  hasRequiredSupportsColor = 1;
  const os = require$$1$1;
  const tty = require$$0$3;
  const hasFlag2 = requireHasFlag();
  const { env } = process;
  let forceColor;
  if (hasFlag2("no-color") || hasFlag2("no-colors") || hasFlag2("color=false") || hasFlag2("color=never")) {
    forceColor = 0;
  } else if (hasFlag2("color") || hasFlag2("colors") || hasFlag2("color=true") || hasFlag2("color=always")) {
    forceColor = 1;
  }
  if ("FORCE_COLOR" in env) {
    if (env.FORCE_COLOR === "true") {
      forceColor = 1;
    } else if (env.FORCE_COLOR === "false") {
      forceColor = 0;
    } else {
      forceColor = env.FORCE_COLOR.length === 0 ? 1 : Math.min(parseInt(env.FORCE_COLOR, 10), 3);
    }
  }
  function translateLevel(level) {
    if (level === 0) {
      return false;
    }
    return {
      level,
      hasBasic: true,
      has256: level >= 2,
      has16m: level >= 3
    };
  }
  function supportsColor(haveStream, streamIsTTY) {
    if (forceColor === 0) {
      return 0;
    }
    if (hasFlag2("color=16m") || hasFlag2("color=full") || hasFlag2("color=truecolor")) {
      return 3;
    }
    if (hasFlag2("color=256")) {
      return 2;
    }
    if (haveStream && !streamIsTTY && forceColor === void 0) {
      return 0;
    }
    const min = forceColor || 0;
    if (env.TERM === "dumb") {
      return min;
    }
    if (process.platform === "win32") {
      const osRelease = os.release().split(".");
      if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
        return Number(osRelease[2]) >= 14931 ? 3 : 2;
      }
      return 1;
    }
    if ("CI" in env) {
      if (["TRAVIS", "CIRCLECI", "APPVEYOR", "GITLAB_CI", "GITHUB_ACTIONS", "BUILDKITE"].some((sign) => sign in env) || env.CI_NAME === "codeship") {
        return 1;
      }
      return min;
    }
    if ("TEAMCITY_VERSION" in env) {
      return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
    }
    if (env.COLORTERM === "truecolor") {
      return 3;
    }
    if ("TERM_PROGRAM" in env) {
      const version = parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
      switch (env.TERM_PROGRAM) {
        case "iTerm.app":
          return version >= 3 ? 3 : 2;
        case "Apple_Terminal":
          return 2;
      }
    }
    if (/-256(color)?$/i.test(env.TERM)) {
      return 2;
    }
    if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
      return 1;
    }
    if ("COLORTERM" in env) {
      return 1;
    }
    return min;
  }
  function getSupportLevel(stream) {
    const level = supportsColor(stream, stream && stream.isTTY);
    return translateLevel(level);
  }
  supportsColor_1 = {
    supportsColor: getSupportLevel,
    stdout: translateLevel(supportsColor(true, tty.isatty(1))),
    stderr: translateLevel(supportsColor(true, tty.isatty(2)))
  };
  return supportsColor_1;
}
var hasRequiredNode;
function requireNode() {
  if (hasRequiredNode) return node.exports;
  hasRequiredNode = 1;
  (function(module2, exports$1) {
    const tty = require$$0$3;
    const util2 = require$$0$1;
    exports$1.init = init;
    exports$1.log = log2;
    exports$1.formatArgs = formatArgs;
    exports$1.save = save;
    exports$1.load = load;
    exports$1.useColors = useColors;
    exports$1.destroy = util2.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports$1.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor = requireSupportsColor();
      if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
        exports$1.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error) {
    }
    exports$1.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports$1.inspectOpts ? Boolean(exports$1.inspectOpts.colors) : tty.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module2.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports$1.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log2(...args) {
      return process.stderr.write(util2.formatWithOptions(exports$1.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug) {
      debug.inspectOpts = {};
      const keys = Object.keys(exports$1.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug.inspectOpts[keys[i]] = exports$1.inspectOpts[keys[i]];
      }
    }
    module2.exports = requireCommon()(exports$1);
    const { formatters } = module2.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util2.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util2.inspect(v, this.inspectOpts);
    };
  })(node, node.exports);
  return node.exports;
}
var hasRequiredSrc;
function requireSrc() {
  if (hasRequiredSrc) return src.exports;
  hasRequiredSrc = 1;
  if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
    src.exports = requireBrowser();
  } else {
    src.exports = requireNode();
  }
  return src.exports;
}
var fs = {};
var hasRequiredFs;
function requireFs() {
  if (hasRequiredFs) return fs;
  hasRequiredFs = 1;
  (function(exports$1) {
    const u = requireUniversalify().fromCallback;
    const fs2 = requireGracefulFs();
    const api = [
      "access",
      "appendFile",
      "chmod",
      "chown",
      "close",
      "copyFile",
      "fchmod",
      "fchown",
      "fdatasync",
      "fstat",
      "fsync",
      "ftruncate",
      "futimes",
      "lchmod",
      "lchown",
      "link",
      "lstat",
      "mkdir",
      "mkdtemp",
      "open",
      "opendir",
      "readdir",
      "readFile",
      "readlink",
      "realpath",
      "rename",
      "rm",
      "rmdir",
      "stat",
      "symlink",
      "truncate",
      "unlink",
      "utimes",
      "writeFile"
    ].filter((key) => {
      return typeof fs2[key] === "function";
    });
    Object.assign(exports$1, fs2);
    api.forEach((method) => {
      exports$1[method] = u(fs2[method]);
    });
    exports$1.exists = function(filename, callback) {
      if (typeof callback === "function") {
        return fs2.exists(filename, callback);
      }
      return new Promise((resolve) => {
        return fs2.exists(filename, resolve);
      });
    };
    exports$1.read = function(fd, buffer, offset, length, position, callback) {
      if (typeof callback === "function") {
        return fs2.read(fd, buffer, offset, length, position, callback);
      }
      return new Promise((resolve, reject) => {
        fs2.read(fd, buffer, offset, length, position, (err, bytesRead, buffer2) => {
          if (err) return reject(err);
          resolve({ bytesRead, buffer: buffer2 });
        });
      });
    };
    exports$1.write = function(fd, buffer, ...args) {
      if (typeof args[args.length - 1] === "function") {
        return fs2.write(fd, buffer, ...args);
      }
      return new Promise((resolve, reject) => {
        fs2.write(fd, buffer, ...args, (err, bytesWritten, buffer2) => {
          if (err) return reject(err);
          resolve({ bytesWritten, buffer: buffer2 });
        });
      });
    };
    if (typeof fs2.writev === "function") {
      exports$1.writev = function(fd, buffers, ...args) {
        if (typeof args[args.length - 1] === "function") {
          return fs2.writev(fd, buffers, ...args);
        }
        return new Promise((resolve, reject) => {
          fs2.writev(fd, buffers, ...args, (err, bytesWritten, buffers2) => {
            if (err) return reject(err);
            resolve({ bytesWritten, buffers: buffers2 });
          });
        });
      };
    }
    if (typeof fs2.realpath.native === "function") {
      exports$1.realpath.native = u(fs2.realpath.native);
    } else {
      process.emitWarning(
        "fs.realpath.native is not a function. Is fs being monkey-patched?",
        "Warning",
        "fs-extra-WARN0003"
      );
    }
  })(fs);
  return fs;
}
var makeDir = {};
var utils = {};
var hasRequiredUtils;
function requireUtils() {
  if (hasRequiredUtils) return utils;
  hasRequiredUtils = 1;
  const path = require$$1;
  utils.checkPath = function checkPath(pth) {
    if (process.platform === "win32") {
      const pathHasInvalidWinCharacters = /[<>:"|?*]/.test(pth.replace(path.parse(pth).root, ""));
      if (pathHasInvalidWinCharacters) {
        const error = new Error(`Path contains invalid characters: ${pth}`);
        error.code = "EINVAL";
        throw error;
      }
    }
  };
  return utils;
}
var hasRequiredMakeDir;
function requireMakeDir() {
  if (hasRequiredMakeDir) return makeDir;
  hasRequiredMakeDir = 1;
  const fs2 = /* @__PURE__ */ requireFs();
  const { checkPath } = /* @__PURE__ */ requireUtils();
  const getMode = (options) => {
    const defaults = { mode: 511 };
    if (typeof options === "number") return options;
    return { ...defaults, ...options }.mode;
  };
  makeDir.makeDir = async (dir, options) => {
    checkPath(dir);
    return fs2.mkdir(dir, {
      mode: getMode(options),
      recursive: true
    });
  };
  makeDir.makeDirSync = (dir, options) => {
    checkPath(dir);
    return fs2.mkdirSync(dir, {
      mode: getMode(options),
      recursive: true
    });
  };
  return makeDir;
}
var mkdirs;
var hasRequiredMkdirs;
function requireMkdirs() {
  if (hasRequiredMkdirs) return mkdirs;
  hasRequiredMkdirs = 1;
  const u = requireUniversalify().fromPromise;
  const { makeDir: _makeDir, makeDirSync } = /* @__PURE__ */ requireMakeDir();
  const makeDir2 = u(_makeDir);
  mkdirs = {
    mkdirs: makeDir2,
    mkdirsSync: makeDirSync,
    // alias
    mkdirp: makeDir2,
    mkdirpSync: makeDirSync,
    ensureDir: makeDir2,
    ensureDirSync: makeDirSync
  };
  return mkdirs;
}
var pathExists_1;
var hasRequiredPathExists;
function requirePathExists() {
  if (hasRequiredPathExists) return pathExists_1;
  hasRequiredPathExists = 1;
  const u = requireUniversalify().fromPromise;
  const fs2 = /* @__PURE__ */ requireFs();
  function pathExists(path) {
    return fs2.access(path).then(() => true).catch(() => false);
  }
  pathExists_1 = {
    pathExists: u(pathExists),
    pathExistsSync: fs2.existsSync
  };
  return pathExists_1;
}
var utimes;
var hasRequiredUtimes;
function requireUtimes() {
  if (hasRequiredUtimes) return utimes;
  hasRequiredUtimes = 1;
  const fs2 = requireGracefulFs();
  function utimesMillis(path, atime, mtime, callback) {
    fs2.open(path, "r+", (err, fd) => {
      if (err) return callback(err);
      fs2.futimes(fd, atime, mtime, (futimesErr) => {
        fs2.close(fd, (closeErr) => {
          if (callback) callback(futimesErr || closeErr);
        });
      });
    });
  }
  function utimesMillisSync(path, atime, mtime) {
    const fd = fs2.openSync(path, "r+");
    fs2.futimesSync(fd, atime, mtime);
    return fs2.closeSync(fd);
  }
  utimes = {
    utimesMillis,
    utimesMillisSync
  };
  return utimes;
}
var stat;
var hasRequiredStat;
function requireStat() {
  if (hasRequiredStat) return stat;
  hasRequiredStat = 1;
  const fs2 = /* @__PURE__ */ requireFs();
  const path = require$$1;
  const util2 = require$$0$1;
  function getStats(src2, dest, opts) {
    const statFunc = opts.dereference ? (file2) => fs2.stat(file2, { bigint: true }) : (file2) => fs2.lstat(file2, { bigint: true });
    return Promise.all([
      statFunc(src2),
      statFunc(dest).catch((err) => {
        if (err.code === "ENOENT") return null;
        throw err;
      })
    ]).then(([srcStat, destStat]) => ({ srcStat, destStat }));
  }
  function getStatsSync(src2, dest, opts) {
    let destStat;
    const statFunc = opts.dereference ? (file2) => fs2.statSync(file2, { bigint: true }) : (file2) => fs2.lstatSync(file2, { bigint: true });
    const srcStat = statFunc(src2);
    try {
      destStat = statFunc(dest);
    } catch (err) {
      if (err.code === "ENOENT") return { srcStat, destStat: null };
      throw err;
    }
    return { srcStat, destStat };
  }
  function checkPaths(src2, dest, funcName, opts, cb) {
    util2.callbackify(getStats)(src2, dest, opts, (err, stats) => {
      if (err) return cb(err);
      const { srcStat, destStat } = stats;
      if (destStat) {
        if (areIdentical(srcStat, destStat)) {
          const srcBaseName = path.basename(src2);
          const destBaseName = path.basename(dest);
          if (funcName === "move" && srcBaseName !== destBaseName && srcBaseName.toLowerCase() === destBaseName.toLowerCase()) {
            return cb(null, { srcStat, destStat, isChangingCase: true });
          }
          return cb(new Error("Source and destination must not be the same."));
        }
        if (srcStat.isDirectory() && !destStat.isDirectory()) {
          return cb(new Error(`Cannot overwrite non-directory '${dest}' with directory '${src2}'.`));
        }
        if (!srcStat.isDirectory() && destStat.isDirectory()) {
          return cb(new Error(`Cannot overwrite directory '${dest}' with non-directory '${src2}'.`));
        }
      }
      if (srcStat.isDirectory() && isSrcSubdir(src2, dest)) {
        return cb(new Error(errMsg(src2, dest, funcName)));
      }
      return cb(null, { srcStat, destStat });
    });
  }
  function checkPathsSync(src2, dest, funcName, opts) {
    const { srcStat, destStat } = getStatsSync(src2, dest, opts);
    if (destStat) {
      if (areIdentical(srcStat, destStat)) {
        const srcBaseName = path.basename(src2);
        const destBaseName = path.basename(dest);
        if (funcName === "move" && srcBaseName !== destBaseName && srcBaseName.toLowerCase() === destBaseName.toLowerCase()) {
          return { srcStat, destStat, isChangingCase: true };
        }
        throw new Error("Source and destination must not be the same.");
      }
      if (srcStat.isDirectory() && !destStat.isDirectory()) {
        throw new Error(`Cannot overwrite non-directory '${dest}' with directory '${src2}'.`);
      }
      if (!srcStat.isDirectory() && destStat.isDirectory()) {
        throw new Error(`Cannot overwrite directory '${dest}' with non-directory '${src2}'.`);
      }
    }
    if (srcStat.isDirectory() && isSrcSubdir(src2, dest)) {
      throw new Error(errMsg(src2, dest, funcName));
    }
    return { srcStat, destStat };
  }
  function checkParentPaths(src2, srcStat, dest, funcName, cb) {
    const srcParent = path.resolve(path.dirname(src2));
    const destParent = path.resolve(path.dirname(dest));
    if (destParent === srcParent || destParent === path.parse(destParent).root) return cb();
    fs2.stat(destParent, { bigint: true }, (err, destStat) => {
      if (err) {
        if (err.code === "ENOENT") return cb();
        return cb(err);
      }
      if (areIdentical(srcStat, destStat)) {
        return cb(new Error(errMsg(src2, dest, funcName)));
      }
      return checkParentPaths(src2, srcStat, destParent, funcName, cb);
    });
  }
  function checkParentPathsSync(src2, srcStat, dest, funcName) {
    const srcParent = path.resolve(path.dirname(src2));
    const destParent = path.resolve(path.dirname(dest));
    if (destParent === srcParent || destParent === path.parse(destParent).root) return;
    let destStat;
    try {
      destStat = fs2.statSync(destParent, { bigint: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    if (areIdentical(srcStat, destStat)) {
      throw new Error(errMsg(src2, dest, funcName));
    }
    return checkParentPathsSync(src2, srcStat, destParent, funcName);
  }
  function areIdentical(srcStat, destStat) {
    return destStat.ino && destStat.dev && destStat.ino === srcStat.ino && destStat.dev === srcStat.dev;
  }
  function isSrcSubdir(src2, dest) {
    const srcArr = path.resolve(src2).split(path.sep).filter((i) => i);
    const destArr = path.resolve(dest).split(path.sep).filter((i) => i);
    return srcArr.reduce((acc, cur, i) => acc && destArr[i] === cur, true);
  }
  function errMsg(src2, dest, funcName) {
    return `Cannot ${funcName} '${src2}' to a subdirectory of itself, '${dest}'.`;
  }
  stat = {
    checkPaths,
    checkPathsSync,
    checkParentPaths,
    checkParentPathsSync,
    isSrcSubdir,
    areIdentical
  };
  return stat;
}
var copy_1;
var hasRequiredCopy$1;
function requireCopy$1() {
  if (hasRequiredCopy$1) return copy_1;
  hasRequiredCopy$1 = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const mkdirs2 = requireMkdirs().mkdirs;
  const pathExists = requirePathExists().pathExists;
  const utimesMillis = requireUtimes().utimesMillis;
  const stat2 = /* @__PURE__ */ requireStat();
  function copy2(src2, dest, opts, cb) {
    if (typeof opts === "function" && !cb) {
      cb = opts;
      opts = {};
    } else if (typeof opts === "function") {
      opts = { filter: opts };
    }
    cb = cb || function() {
    };
    opts = opts || {};
    opts.clobber = "clobber" in opts ? !!opts.clobber : true;
    opts.overwrite = "overwrite" in opts ? !!opts.overwrite : opts.clobber;
    if (opts.preserveTimestamps && process.arch === "ia32") {
      process.emitWarning(
        "Using the preserveTimestamps option in 32-bit node is not recommended;\n\n	see https://github.com/jprichardson/node-fs-extra/issues/269",
        "Warning",
        "fs-extra-WARN0001"
      );
    }
    stat2.checkPaths(src2, dest, "copy", opts, (err, stats) => {
      if (err) return cb(err);
      const { srcStat, destStat } = stats;
      stat2.checkParentPaths(src2, srcStat, dest, "copy", (err2) => {
        if (err2) return cb(err2);
        if (opts.filter) return handleFilter(checkParentDir, destStat, src2, dest, opts, cb);
        return checkParentDir(destStat, src2, dest, opts, cb);
      });
    });
  }
  function checkParentDir(destStat, src2, dest, opts, cb) {
    const destParent = path.dirname(dest);
    pathExists(destParent, (err, dirExists) => {
      if (err) return cb(err);
      if (dirExists) return getStats(destStat, src2, dest, opts, cb);
      mkdirs2(destParent, (err2) => {
        if (err2) return cb(err2);
        return getStats(destStat, src2, dest, opts, cb);
      });
    });
  }
  function handleFilter(onInclude, destStat, src2, dest, opts, cb) {
    Promise.resolve(opts.filter(src2, dest)).then((include) => {
      if (include) return onInclude(destStat, src2, dest, opts, cb);
      return cb();
    }, (error) => cb(error));
  }
  function startCopy(destStat, src2, dest, opts, cb) {
    if (opts.filter) return handleFilter(getStats, destStat, src2, dest, opts, cb);
    return getStats(destStat, src2, dest, opts, cb);
  }
  function getStats(destStat, src2, dest, opts, cb) {
    const stat3 = opts.dereference ? fs2.stat : fs2.lstat;
    stat3(src2, (err, srcStat) => {
      if (err) return cb(err);
      if (srcStat.isDirectory()) return onDir(srcStat, destStat, src2, dest, opts, cb);
      else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) return onFile(srcStat, destStat, src2, dest, opts, cb);
      else if (srcStat.isSymbolicLink()) return onLink(destStat, src2, dest, opts, cb);
      else if (srcStat.isSocket()) return cb(new Error(`Cannot copy a socket file: ${src2}`));
      else if (srcStat.isFIFO()) return cb(new Error(`Cannot copy a FIFO pipe: ${src2}`));
      return cb(new Error(`Unknown file: ${src2}`));
    });
  }
  function onFile(srcStat, destStat, src2, dest, opts, cb) {
    if (!destStat) return copyFile(srcStat, src2, dest, opts, cb);
    return mayCopyFile(srcStat, src2, dest, opts, cb);
  }
  function mayCopyFile(srcStat, src2, dest, opts, cb) {
    if (opts.overwrite) {
      fs2.unlink(dest, (err) => {
        if (err) return cb(err);
        return copyFile(srcStat, src2, dest, opts, cb);
      });
    } else if (opts.errorOnExist) {
      return cb(new Error(`'${dest}' already exists`));
    } else return cb();
  }
  function copyFile(srcStat, src2, dest, opts, cb) {
    fs2.copyFile(src2, dest, (err) => {
      if (err) return cb(err);
      if (opts.preserveTimestamps) return handleTimestampsAndMode(srcStat.mode, src2, dest, cb);
      return setDestMode(dest, srcStat.mode, cb);
    });
  }
  function handleTimestampsAndMode(srcMode, src2, dest, cb) {
    if (fileIsNotWritable(srcMode)) {
      return makeFileWritable(dest, srcMode, (err) => {
        if (err) return cb(err);
        return setDestTimestampsAndMode(srcMode, src2, dest, cb);
      });
    }
    return setDestTimestampsAndMode(srcMode, src2, dest, cb);
  }
  function fileIsNotWritable(srcMode) {
    return (srcMode & 128) === 0;
  }
  function makeFileWritable(dest, srcMode, cb) {
    return setDestMode(dest, srcMode | 128, cb);
  }
  function setDestTimestampsAndMode(srcMode, src2, dest, cb) {
    setDestTimestamps(src2, dest, (err) => {
      if (err) return cb(err);
      return setDestMode(dest, srcMode, cb);
    });
  }
  function setDestMode(dest, srcMode, cb) {
    return fs2.chmod(dest, srcMode, cb);
  }
  function setDestTimestamps(src2, dest, cb) {
    fs2.stat(src2, (err, updatedSrcStat) => {
      if (err) return cb(err);
      return utimesMillis(dest, updatedSrcStat.atime, updatedSrcStat.mtime, cb);
    });
  }
  function onDir(srcStat, destStat, src2, dest, opts, cb) {
    if (!destStat) return mkDirAndCopy(srcStat.mode, src2, dest, opts, cb);
    return copyDir(src2, dest, opts, cb);
  }
  function mkDirAndCopy(srcMode, src2, dest, opts, cb) {
    fs2.mkdir(dest, (err) => {
      if (err) return cb(err);
      copyDir(src2, dest, opts, (err2) => {
        if (err2) return cb(err2);
        return setDestMode(dest, srcMode, cb);
      });
    });
  }
  function copyDir(src2, dest, opts, cb) {
    fs2.readdir(src2, (err, items) => {
      if (err) return cb(err);
      return copyDirItems(items, src2, dest, opts, cb);
    });
  }
  function copyDirItems(items, src2, dest, opts, cb) {
    const item = items.pop();
    if (!item) return cb();
    return copyDirItem(items, item, src2, dest, opts, cb);
  }
  function copyDirItem(items, item, src2, dest, opts, cb) {
    const srcItem = path.join(src2, item);
    const destItem = path.join(dest, item);
    stat2.checkPaths(srcItem, destItem, "copy", opts, (err, stats) => {
      if (err) return cb(err);
      const { destStat } = stats;
      startCopy(destStat, srcItem, destItem, opts, (err2) => {
        if (err2) return cb(err2);
        return copyDirItems(items, src2, dest, opts, cb);
      });
    });
  }
  function onLink(destStat, src2, dest, opts, cb) {
    fs2.readlink(src2, (err, resolvedSrc) => {
      if (err) return cb(err);
      if (opts.dereference) {
        resolvedSrc = path.resolve(process.cwd(), resolvedSrc);
      }
      if (!destStat) {
        return fs2.symlink(resolvedSrc, dest, cb);
      } else {
        fs2.readlink(dest, (err2, resolvedDest) => {
          if (err2) {
            if (err2.code === "EINVAL" || err2.code === "UNKNOWN") return fs2.symlink(resolvedSrc, dest, cb);
            return cb(err2);
          }
          if (opts.dereference) {
            resolvedDest = path.resolve(process.cwd(), resolvedDest);
          }
          if (stat2.isSrcSubdir(resolvedSrc, resolvedDest)) {
            return cb(new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`));
          }
          if (destStat.isDirectory() && stat2.isSrcSubdir(resolvedDest, resolvedSrc)) {
            return cb(new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`));
          }
          return copyLink(resolvedSrc, dest, cb);
        });
      }
    });
  }
  function copyLink(resolvedSrc, dest, cb) {
    fs2.unlink(dest, (err) => {
      if (err) return cb(err);
      return fs2.symlink(resolvedSrc, dest, cb);
    });
  }
  copy_1 = copy2;
  return copy_1;
}
var copySync_1;
var hasRequiredCopySync;
function requireCopySync() {
  if (hasRequiredCopySync) return copySync_1;
  hasRequiredCopySync = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const mkdirsSync = requireMkdirs().mkdirsSync;
  const utimesMillisSync = requireUtimes().utimesMillisSync;
  const stat2 = /* @__PURE__ */ requireStat();
  function copySync(src2, dest, opts) {
    if (typeof opts === "function") {
      opts = { filter: opts };
    }
    opts = opts || {};
    opts.clobber = "clobber" in opts ? !!opts.clobber : true;
    opts.overwrite = "overwrite" in opts ? !!opts.overwrite : opts.clobber;
    if (opts.preserveTimestamps && process.arch === "ia32") {
      process.emitWarning(
        "Using the preserveTimestamps option in 32-bit node is not recommended;\n\n	see https://github.com/jprichardson/node-fs-extra/issues/269",
        "Warning",
        "fs-extra-WARN0002"
      );
    }
    const { srcStat, destStat } = stat2.checkPathsSync(src2, dest, "copy", opts);
    stat2.checkParentPathsSync(src2, srcStat, dest, "copy");
    return handleFilterAndCopy(destStat, src2, dest, opts);
  }
  function handleFilterAndCopy(destStat, src2, dest, opts) {
    if (opts.filter && !opts.filter(src2, dest)) return;
    const destParent = path.dirname(dest);
    if (!fs2.existsSync(destParent)) mkdirsSync(destParent);
    return getStats(destStat, src2, dest, opts);
  }
  function startCopy(destStat, src2, dest, opts) {
    if (opts.filter && !opts.filter(src2, dest)) return;
    return getStats(destStat, src2, dest, opts);
  }
  function getStats(destStat, src2, dest, opts) {
    const statSync = opts.dereference ? fs2.statSync : fs2.lstatSync;
    const srcStat = statSync(src2);
    if (srcStat.isDirectory()) return onDir(srcStat, destStat, src2, dest, opts);
    else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) return onFile(srcStat, destStat, src2, dest, opts);
    else if (srcStat.isSymbolicLink()) return onLink(destStat, src2, dest, opts);
    else if (srcStat.isSocket()) throw new Error(`Cannot copy a socket file: ${src2}`);
    else if (srcStat.isFIFO()) throw new Error(`Cannot copy a FIFO pipe: ${src2}`);
    throw new Error(`Unknown file: ${src2}`);
  }
  function onFile(srcStat, destStat, src2, dest, opts) {
    if (!destStat) return copyFile(srcStat, src2, dest, opts);
    return mayCopyFile(srcStat, src2, dest, opts);
  }
  function mayCopyFile(srcStat, src2, dest, opts) {
    if (opts.overwrite) {
      fs2.unlinkSync(dest);
      return copyFile(srcStat, src2, dest, opts);
    } else if (opts.errorOnExist) {
      throw new Error(`'${dest}' already exists`);
    }
  }
  function copyFile(srcStat, src2, dest, opts) {
    fs2.copyFileSync(src2, dest);
    if (opts.preserveTimestamps) handleTimestamps(srcStat.mode, src2, dest);
    return setDestMode(dest, srcStat.mode);
  }
  function handleTimestamps(srcMode, src2, dest) {
    if (fileIsNotWritable(srcMode)) makeFileWritable(dest, srcMode);
    return setDestTimestamps(src2, dest);
  }
  function fileIsNotWritable(srcMode) {
    return (srcMode & 128) === 0;
  }
  function makeFileWritable(dest, srcMode) {
    return setDestMode(dest, srcMode | 128);
  }
  function setDestMode(dest, srcMode) {
    return fs2.chmodSync(dest, srcMode);
  }
  function setDestTimestamps(src2, dest) {
    const updatedSrcStat = fs2.statSync(src2);
    return utimesMillisSync(dest, updatedSrcStat.atime, updatedSrcStat.mtime);
  }
  function onDir(srcStat, destStat, src2, dest, opts) {
    if (!destStat) return mkDirAndCopy(srcStat.mode, src2, dest, opts);
    return copyDir(src2, dest, opts);
  }
  function mkDirAndCopy(srcMode, src2, dest, opts) {
    fs2.mkdirSync(dest);
    copyDir(src2, dest, opts);
    return setDestMode(dest, srcMode);
  }
  function copyDir(src2, dest, opts) {
    fs2.readdirSync(src2).forEach((item) => copyDirItem(item, src2, dest, opts));
  }
  function copyDirItem(item, src2, dest, opts) {
    const srcItem = path.join(src2, item);
    const destItem = path.join(dest, item);
    const { destStat } = stat2.checkPathsSync(srcItem, destItem, "copy", opts);
    return startCopy(destStat, srcItem, destItem, opts);
  }
  function onLink(destStat, src2, dest, opts) {
    let resolvedSrc = fs2.readlinkSync(src2);
    if (opts.dereference) {
      resolvedSrc = path.resolve(process.cwd(), resolvedSrc);
    }
    if (!destStat) {
      return fs2.symlinkSync(resolvedSrc, dest);
    } else {
      let resolvedDest;
      try {
        resolvedDest = fs2.readlinkSync(dest);
      } catch (err) {
        if (err.code === "EINVAL" || err.code === "UNKNOWN") return fs2.symlinkSync(resolvedSrc, dest);
        throw err;
      }
      if (opts.dereference) {
        resolvedDest = path.resolve(process.cwd(), resolvedDest);
      }
      if (stat2.isSrcSubdir(resolvedSrc, resolvedDest)) {
        throw new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`);
      }
      if (fs2.statSync(dest).isDirectory() && stat2.isSrcSubdir(resolvedDest, resolvedSrc)) {
        throw new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`);
      }
      return copyLink(resolvedSrc, dest);
    }
  }
  function copyLink(resolvedSrc, dest) {
    fs2.unlinkSync(dest);
    return fs2.symlinkSync(resolvedSrc, dest);
  }
  copySync_1 = copySync;
  return copySync_1;
}
var copy;
var hasRequiredCopy;
function requireCopy() {
  if (hasRequiredCopy) return copy;
  hasRequiredCopy = 1;
  const u = requireUniversalify().fromCallback;
  copy = {
    copy: u(/* @__PURE__ */ requireCopy$1()),
    copySync: /* @__PURE__ */ requireCopySync()
  };
  return copy;
}
var rimraf_1;
var hasRequiredRimraf;
function requireRimraf() {
  if (hasRequiredRimraf) return rimraf_1;
  hasRequiredRimraf = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const assert = require$$2;
  const isWindows = process.platform === "win32";
  function defaults(options) {
    const methods = [
      "unlink",
      "chmod",
      "stat",
      "lstat",
      "rmdir",
      "readdir"
    ];
    methods.forEach((m) => {
      options[m] = options[m] || fs2[m];
      m = m + "Sync";
      options[m] = options[m] || fs2[m];
    });
    options.maxBusyTries = options.maxBusyTries || 3;
  }
  function rimraf(p, options, cb) {
    let busyTries = 0;
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    assert(p, "rimraf: missing path");
    assert.strictEqual(typeof p, "string", "rimraf: path should be a string");
    assert.strictEqual(typeof cb, "function", "rimraf: callback function required");
    assert(options, "rimraf: invalid options argument provided");
    assert.strictEqual(typeof options, "object", "rimraf: options should be object");
    defaults(options);
    rimraf_(p, options, function CB(er) {
      if (er) {
        if ((er.code === "EBUSY" || er.code === "ENOTEMPTY" || er.code === "EPERM") && busyTries < options.maxBusyTries) {
          busyTries++;
          const time = busyTries * 100;
          return setTimeout(() => rimraf_(p, options, CB), time);
        }
        if (er.code === "ENOENT") er = null;
      }
      cb(er);
    });
  }
  function rimraf_(p, options, cb) {
    assert(p);
    assert(options);
    assert(typeof cb === "function");
    options.lstat(p, (er, st) => {
      if (er && er.code === "ENOENT") {
        return cb(null);
      }
      if (er && er.code === "EPERM" && isWindows) {
        return fixWinEPERM(p, options, er, cb);
      }
      if (st && st.isDirectory()) {
        return rmdir(p, options, er, cb);
      }
      options.unlink(p, (er2) => {
        if (er2) {
          if (er2.code === "ENOENT") {
            return cb(null);
          }
          if (er2.code === "EPERM") {
            return isWindows ? fixWinEPERM(p, options, er2, cb) : rmdir(p, options, er2, cb);
          }
          if (er2.code === "EISDIR") {
            return rmdir(p, options, er2, cb);
          }
        }
        return cb(er2);
      });
    });
  }
  function fixWinEPERM(p, options, er, cb) {
    assert(p);
    assert(options);
    assert(typeof cb === "function");
    options.chmod(p, 438, (er2) => {
      if (er2) {
        cb(er2.code === "ENOENT" ? null : er);
      } else {
        options.stat(p, (er3, stats) => {
          if (er3) {
            cb(er3.code === "ENOENT" ? null : er);
          } else if (stats.isDirectory()) {
            rmdir(p, options, er, cb);
          } else {
            options.unlink(p, cb);
          }
        });
      }
    });
  }
  function fixWinEPERMSync(p, options, er) {
    let stats;
    assert(p);
    assert(options);
    try {
      options.chmodSync(p, 438);
    } catch (er2) {
      if (er2.code === "ENOENT") {
        return;
      } else {
        throw er;
      }
    }
    try {
      stats = options.statSync(p);
    } catch (er3) {
      if (er3.code === "ENOENT") {
        return;
      } else {
        throw er;
      }
    }
    if (stats.isDirectory()) {
      rmdirSync(p, options, er);
    } else {
      options.unlinkSync(p);
    }
  }
  function rmdir(p, options, originalEr, cb) {
    assert(p);
    assert(options);
    assert(typeof cb === "function");
    options.rmdir(p, (er) => {
      if (er && (er.code === "ENOTEMPTY" || er.code === "EEXIST" || er.code === "EPERM")) {
        rmkids(p, options, cb);
      } else if (er && er.code === "ENOTDIR") {
        cb(originalEr);
      } else {
        cb(er);
      }
    });
  }
  function rmkids(p, options, cb) {
    assert(p);
    assert(options);
    assert(typeof cb === "function");
    options.readdir(p, (er, files) => {
      if (er) return cb(er);
      let n = files.length;
      let errState;
      if (n === 0) return options.rmdir(p, cb);
      files.forEach((f) => {
        rimraf(path.join(p, f), options, (er2) => {
          if (errState) {
            return;
          }
          if (er2) return cb(errState = er2);
          if (--n === 0) {
            options.rmdir(p, cb);
          }
        });
      });
    });
  }
  function rimrafSync(p, options) {
    let st;
    options = options || {};
    defaults(options);
    assert(p, "rimraf: missing path");
    assert.strictEqual(typeof p, "string", "rimraf: path should be a string");
    assert(options, "rimraf: missing options");
    assert.strictEqual(typeof options, "object", "rimraf: options should be object");
    try {
      st = options.lstatSync(p);
    } catch (er) {
      if (er.code === "ENOENT") {
        return;
      }
      if (er.code === "EPERM" && isWindows) {
        fixWinEPERMSync(p, options, er);
      }
    }
    try {
      if (st && st.isDirectory()) {
        rmdirSync(p, options, null);
      } else {
        options.unlinkSync(p);
      }
    } catch (er) {
      if (er.code === "ENOENT") {
        return;
      } else if (er.code === "EPERM") {
        return isWindows ? fixWinEPERMSync(p, options, er) : rmdirSync(p, options, er);
      } else if (er.code !== "EISDIR") {
        throw er;
      }
      rmdirSync(p, options, er);
    }
  }
  function rmdirSync(p, options, originalEr) {
    assert(p);
    assert(options);
    try {
      options.rmdirSync(p);
    } catch (er) {
      if (er.code === "ENOTDIR") {
        throw originalEr;
      } else if (er.code === "ENOTEMPTY" || er.code === "EEXIST" || er.code === "EPERM") {
        rmkidsSync(p, options);
      } else if (er.code !== "ENOENT") {
        throw er;
      }
    }
  }
  function rmkidsSync(p, options) {
    assert(p);
    assert(options);
    options.readdirSync(p).forEach((f) => rimrafSync(path.join(p, f), options));
    if (isWindows) {
      const startTime = Date.now();
      do {
        try {
          const ret = options.rmdirSync(p, options);
          return ret;
        } catch {
        }
      } while (Date.now() - startTime < 500);
    } else {
      const ret = options.rmdirSync(p, options);
      return ret;
    }
  }
  rimraf_1 = rimraf;
  rimraf.sync = rimrafSync;
  return rimraf_1;
}
var remove_1;
var hasRequiredRemove;
function requireRemove() {
  if (hasRequiredRemove) return remove_1;
  hasRequiredRemove = 1;
  const fs2 = requireGracefulFs();
  const u = requireUniversalify().fromCallback;
  const rimraf = /* @__PURE__ */ requireRimraf();
  function remove(path, callback) {
    if (fs2.rm) return fs2.rm(path, { recursive: true, force: true }, callback);
    rimraf(path, callback);
  }
  function removeSync(path) {
    if (fs2.rmSync) return fs2.rmSync(path, { recursive: true, force: true });
    rimraf.sync(path);
  }
  remove_1 = {
    remove: u(remove),
    removeSync
  };
  return remove_1;
}
var empty;
var hasRequiredEmpty;
function requireEmpty() {
  if (hasRequiredEmpty) return empty;
  hasRequiredEmpty = 1;
  const u = requireUniversalify().fromPromise;
  const fs2 = /* @__PURE__ */ requireFs();
  const path = require$$1;
  const mkdir = /* @__PURE__ */ requireMkdirs();
  const remove = /* @__PURE__ */ requireRemove();
  const emptyDir = u(async function emptyDir2(dir) {
    let items;
    try {
      items = await fs2.readdir(dir);
    } catch {
      return mkdir.mkdirs(dir);
    }
    return Promise.all(items.map((item) => remove.remove(path.join(dir, item))));
  });
  function emptyDirSync(dir) {
    let items;
    try {
      items = fs2.readdirSync(dir);
    } catch {
      return mkdir.mkdirsSync(dir);
    }
    items.forEach((item) => {
      item = path.join(dir, item);
      remove.removeSync(item);
    });
  }
  empty = {
    emptyDirSync,
    emptydirSync: emptyDirSync,
    emptyDir,
    emptydir: emptyDir
  };
  return empty;
}
var file;
var hasRequiredFile;
function requireFile() {
  if (hasRequiredFile) return file;
  hasRequiredFile = 1;
  const u = requireUniversalify().fromCallback;
  const path = require$$1;
  const fs2 = requireGracefulFs();
  const mkdir = /* @__PURE__ */ requireMkdirs();
  function createFile(file2, callback) {
    function makeFile() {
      fs2.writeFile(file2, "", (err) => {
        if (err) return callback(err);
        callback();
      });
    }
    fs2.stat(file2, (err, stats) => {
      if (!err && stats.isFile()) return callback();
      const dir = path.dirname(file2);
      fs2.stat(dir, (err2, stats2) => {
        if (err2) {
          if (err2.code === "ENOENT") {
            return mkdir.mkdirs(dir, (err3) => {
              if (err3) return callback(err3);
              makeFile();
            });
          }
          return callback(err2);
        }
        if (stats2.isDirectory()) makeFile();
        else {
          fs2.readdir(dir, (err3) => {
            if (err3) return callback(err3);
          });
        }
      });
    });
  }
  function createFileSync(file2) {
    let stats;
    try {
      stats = fs2.statSync(file2);
    } catch {
    }
    if (stats && stats.isFile()) return;
    const dir = path.dirname(file2);
    try {
      if (!fs2.statSync(dir).isDirectory()) {
        fs2.readdirSync(dir);
      }
    } catch (err) {
      if (err && err.code === "ENOENT") mkdir.mkdirsSync(dir);
      else throw err;
    }
    fs2.writeFileSync(file2, "");
  }
  file = {
    createFile: u(createFile),
    createFileSync
  };
  return file;
}
var link;
var hasRequiredLink;
function requireLink() {
  if (hasRequiredLink) return link;
  hasRequiredLink = 1;
  const u = requireUniversalify().fromCallback;
  const path = require$$1;
  const fs2 = requireGracefulFs();
  const mkdir = /* @__PURE__ */ requireMkdirs();
  const pathExists = requirePathExists().pathExists;
  const { areIdentical } = /* @__PURE__ */ requireStat();
  function createLink(srcpath, dstpath, callback) {
    function makeLink(srcpath2, dstpath2) {
      fs2.link(srcpath2, dstpath2, (err) => {
        if (err) return callback(err);
        callback(null);
      });
    }
    fs2.lstat(dstpath, (_, dstStat) => {
      fs2.lstat(srcpath, (err, srcStat) => {
        if (err) {
          err.message = err.message.replace("lstat", "ensureLink");
          return callback(err);
        }
        if (dstStat && areIdentical(srcStat, dstStat)) return callback(null);
        const dir = path.dirname(dstpath);
        pathExists(dir, (err2, dirExists) => {
          if (err2) return callback(err2);
          if (dirExists) return makeLink(srcpath, dstpath);
          mkdir.mkdirs(dir, (err3) => {
            if (err3) return callback(err3);
            makeLink(srcpath, dstpath);
          });
        });
      });
    });
  }
  function createLinkSync(srcpath, dstpath) {
    let dstStat;
    try {
      dstStat = fs2.lstatSync(dstpath);
    } catch {
    }
    try {
      const srcStat = fs2.lstatSync(srcpath);
      if (dstStat && areIdentical(srcStat, dstStat)) return;
    } catch (err) {
      err.message = err.message.replace("lstat", "ensureLink");
      throw err;
    }
    const dir = path.dirname(dstpath);
    const dirExists = fs2.existsSync(dir);
    if (dirExists) return fs2.linkSync(srcpath, dstpath);
    mkdir.mkdirsSync(dir);
    return fs2.linkSync(srcpath, dstpath);
  }
  link = {
    createLink: u(createLink),
    createLinkSync
  };
  return link;
}
var symlinkPaths_1;
var hasRequiredSymlinkPaths;
function requireSymlinkPaths() {
  if (hasRequiredSymlinkPaths) return symlinkPaths_1;
  hasRequiredSymlinkPaths = 1;
  const path = require$$1;
  const fs2 = requireGracefulFs();
  const pathExists = requirePathExists().pathExists;
  function symlinkPaths(srcpath, dstpath, callback) {
    if (path.isAbsolute(srcpath)) {
      return fs2.lstat(srcpath, (err) => {
        if (err) {
          err.message = err.message.replace("lstat", "ensureSymlink");
          return callback(err);
        }
        return callback(null, {
          toCwd: srcpath,
          toDst: srcpath
        });
      });
    } else {
      const dstdir = path.dirname(dstpath);
      const relativeToDst = path.join(dstdir, srcpath);
      return pathExists(relativeToDst, (err, exists) => {
        if (err) return callback(err);
        if (exists) {
          return callback(null, {
            toCwd: relativeToDst,
            toDst: srcpath
          });
        } else {
          return fs2.lstat(srcpath, (err2) => {
            if (err2) {
              err2.message = err2.message.replace("lstat", "ensureSymlink");
              return callback(err2);
            }
            return callback(null, {
              toCwd: srcpath,
              toDst: path.relative(dstdir, srcpath)
            });
          });
        }
      });
    }
  }
  function symlinkPathsSync(srcpath, dstpath) {
    let exists;
    if (path.isAbsolute(srcpath)) {
      exists = fs2.existsSync(srcpath);
      if (!exists) throw new Error("absolute srcpath does not exist");
      return {
        toCwd: srcpath,
        toDst: srcpath
      };
    } else {
      const dstdir = path.dirname(dstpath);
      const relativeToDst = path.join(dstdir, srcpath);
      exists = fs2.existsSync(relativeToDst);
      if (exists) {
        return {
          toCwd: relativeToDst,
          toDst: srcpath
        };
      } else {
        exists = fs2.existsSync(srcpath);
        if (!exists) throw new Error("relative srcpath does not exist");
        return {
          toCwd: srcpath,
          toDst: path.relative(dstdir, srcpath)
        };
      }
    }
  }
  symlinkPaths_1 = {
    symlinkPaths,
    symlinkPathsSync
  };
  return symlinkPaths_1;
}
var symlinkType_1;
var hasRequiredSymlinkType;
function requireSymlinkType() {
  if (hasRequiredSymlinkType) return symlinkType_1;
  hasRequiredSymlinkType = 1;
  const fs2 = requireGracefulFs();
  function symlinkType(srcpath, type, callback) {
    callback = typeof type === "function" ? type : callback;
    type = typeof type === "function" ? false : type;
    if (type) return callback(null, type);
    fs2.lstat(srcpath, (err, stats) => {
      if (err) return callback(null, "file");
      type = stats && stats.isDirectory() ? "dir" : "file";
      callback(null, type);
    });
  }
  function symlinkTypeSync(srcpath, type) {
    let stats;
    if (type) return type;
    try {
      stats = fs2.lstatSync(srcpath);
    } catch {
      return "file";
    }
    return stats && stats.isDirectory() ? "dir" : "file";
  }
  symlinkType_1 = {
    symlinkType,
    symlinkTypeSync
  };
  return symlinkType_1;
}
var symlink;
var hasRequiredSymlink;
function requireSymlink() {
  if (hasRequiredSymlink) return symlink;
  hasRequiredSymlink = 1;
  const u = requireUniversalify().fromCallback;
  const path = require$$1;
  const fs2 = /* @__PURE__ */ requireFs();
  const _mkdirs = /* @__PURE__ */ requireMkdirs();
  const mkdirs2 = _mkdirs.mkdirs;
  const mkdirsSync = _mkdirs.mkdirsSync;
  const _symlinkPaths = /* @__PURE__ */ requireSymlinkPaths();
  const symlinkPaths = _symlinkPaths.symlinkPaths;
  const symlinkPathsSync = _symlinkPaths.symlinkPathsSync;
  const _symlinkType = /* @__PURE__ */ requireSymlinkType();
  const symlinkType = _symlinkType.symlinkType;
  const symlinkTypeSync = _symlinkType.symlinkTypeSync;
  const pathExists = requirePathExists().pathExists;
  const { areIdentical } = /* @__PURE__ */ requireStat();
  function createSymlink(srcpath, dstpath, type, callback) {
    callback = typeof type === "function" ? type : callback;
    type = typeof type === "function" ? false : type;
    fs2.lstat(dstpath, (err, stats) => {
      if (!err && stats.isSymbolicLink()) {
        Promise.all([
          fs2.stat(srcpath),
          fs2.stat(dstpath)
        ]).then(([srcStat, dstStat]) => {
          if (areIdentical(srcStat, dstStat)) return callback(null);
          _createSymlink(srcpath, dstpath, type, callback);
        });
      } else _createSymlink(srcpath, dstpath, type, callback);
    });
  }
  function _createSymlink(srcpath, dstpath, type, callback) {
    symlinkPaths(srcpath, dstpath, (err, relative) => {
      if (err) return callback(err);
      srcpath = relative.toDst;
      symlinkType(relative.toCwd, type, (err2, type2) => {
        if (err2) return callback(err2);
        const dir = path.dirname(dstpath);
        pathExists(dir, (err3, dirExists) => {
          if (err3) return callback(err3);
          if (dirExists) return fs2.symlink(srcpath, dstpath, type2, callback);
          mkdirs2(dir, (err4) => {
            if (err4) return callback(err4);
            fs2.symlink(srcpath, dstpath, type2, callback);
          });
        });
      });
    });
  }
  function createSymlinkSync(srcpath, dstpath, type) {
    let stats;
    try {
      stats = fs2.lstatSync(dstpath);
    } catch {
    }
    if (stats && stats.isSymbolicLink()) {
      const srcStat = fs2.statSync(srcpath);
      const dstStat = fs2.statSync(dstpath);
      if (areIdentical(srcStat, dstStat)) return;
    }
    const relative = symlinkPathsSync(srcpath, dstpath);
    srcpath = relative.toDst;
    type = symlinkTypeSync(relative.toCwd, type);
    const dir = path.dirname(dstpath);
    const exists = fs2.existsSync(dir);
    if (exists) return fs2.symlinkSync(srcpath, dstpath, type);
    mkdirsSync(dir);
    return fs2.symlinkSync(srcpath, dstpath, type);
  }
  symlink = {
    createSymlink: u(createSymlink),
    createSymlinkSync
  };
  return symlink;
}
var ensure;
var hasRequiredEnsure;
function requireEnsure() {
  if (hasRequiredEnsure) return ensure;
  hasRequiredEnsure = 1;
  const { createFile, createFileSync } = /* @__PURE__ */ requireFile();
  const { createLink, createLinkSync } = /* @__PURE__ */ requireLink();
  const { createSymlink, createSymlinkSync } = /* @__PURE__ */ requireSymlink();
  ensure = {
    // file
    createFile,
    createFileSync,
    ensureFile: createFile,
    ensureFileSync: createFileSync,
    // link
    createLink,
    createLinkSync,
    ensureLink: createLink,
    ensureLinkSync: createLinkSync,
    // symlink
    createSymlink,
    createSymlinkSync,
    ensureSymlink: createSymlink,
    ensureSymlinkSync: createSymlinkSync
  };
  return ensure;
}
var jsonfile;
var hasRequiredJsonfile;
function requireJsonfile() {
  if (hasRequiredJsonfile) return jsonfile;
  hasRequiredJsonfile = 1;
  const jsonFile = requireJsonfile$2();
  jsonfile = {
    // jsonfile exports
    readJson: jsonFile.readFile,
    readJsonSync: jsonFile.readFileSync,
    writeJson: jsonFile.writeFile,
    writeJsonSync: jsonFile.writeFileSync
  };
  return jsonfile;
}
var outputFile_1;
var hasRequiredOutputFile;
function requireOutputFile() {
  if (hasRequiredOutputFile) return outputFile_1;
  hasRequiredOutputFile = 1;
  const u = requireUniversalify().fromCallback;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const mkdir = /* @__PURE__ */ requireMkdirs();
  const pathExists = requirePathExists().pathExists;
  function outputFile(file2, data, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = "utf8";
    }
    const dir = path.dirname(file2);
    pathExists(dir, (err, itDoes) => {
      if (err) return callback(err);
      if (itDoes) return fs2.writeFile(file2, data, encoding, callback);
      mkdir.mkdirs(dir, (err2) => {
        if (err2) return callback(err2);
        fs2.writeFile(file2, data, encoding, callback);
      });
    });
  }
  function outputFileSync(file2, ...args) {
    const dir = path.dirname(file2);
    if (fs2.existsSync(dir)) {
      return fs2.writeFileSync(file2, ...args);
    }
    mkdir.mkdirsSync(dir);
    fs2.writeFileSync(file2, ...args);
  }
  outputFile_1 = {
    outputFile: u(outputFile),
    outputFileSync
  };
  return outputFile_1;
}
var outputJson_1;
var hasRequiredOutputJson;
function requireOutputJson() {
  if (hasRequiredOutputJson) return outputJson_1;
  hasRequiredOutputJson = 1;
  const { stringify } = requireUtils$1();
  const { outputFile } = /* @__PURE__ */ requireOutputFile();
  async function outputJson(file2, data, options = {}) {
    const str = stringify(data, options);
    await outputFile(file2, str, options);
  }
  outputJson_1 = outputJson;
  return outputJson_1;
}
var outputJsonSync_1;
var hasRequiredOutputJsonSync;
function requireOutputJsonSync() {
  if (hasRequiredOutputJsonSync) return outputJsonSync_1;
  hasRequiredOutputJsonSync = 1;
  const { stringify } = requireUtils$1();
  const { outputFileSync } = /* @__PURE__ */ requireOutputFile();
  function outputJsonSync(file2, data, options) {
    const str = stringify(data, options);
    outputFileSync(file2, str, options);
  }
  outputJsonSync_1 = outputJsonSync;
  return outputJsonSync_1;
}
var json;
var hasRequiredJson;
function requireJson() {
  if (hasRequiredJson) return json;
  hasRequiredJson = 1;
  const u = requireUniversalify().fromPromise;
  const jsonFile = /* @__PURE__ */ requireJsonfile();
  jsonFile.outputJson = u(/* @__PURE__ */ requireOutputJson());
  jsonFile.outputJsonSync = /* @__PURE__ */ requireOutputJsonSync();
  jsonFile.outputJSON = jsonFile.outputJson;
  jsonFile.outputJSONSync = jsonFile.outputJsonSync;
  jsonFile.writeJSON = jsonFile.writeJson;
  jsonFile.writeJSONSync = jsonFile.writeJsonSync;
  jsonFile.readJSON = jsonFile.readJson;
  jsonFile.readJSONSync = jsonFile.readJsonSync;
  json = jsonFile;
  return json;
}
var move_1;
var hasRequiredMove$1;
function requireMove$1() {
  if (hasRequiredMove$1) return move_1;
  hasRequiredMove$1 = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const copy2 = requireCopy().copy;
  const remove = requireRemove().remove;
  const mkdirp = requireMkdirs().mkdirp;
  const pathExists = requirePathExists().pathExists;
  const stat2 = /* @__PURE__ */ requireStat();
  function move2(src2, dest, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    const overwrite = opts.overwrite || opts.clobber || false;
    stat2.checkPaths(src2, dest, "move", opts, (err, stats) => {
      if (err) return cb(err);
      const { srcStat, isChangingCase = false } = stats;
      stat2.checkParentPaths(src2, srcStat, dest, "move", (err2) => {
        if (err2) return cb(err2);
        if (isParentRoot(dest)) return doRename(src2, dest, overwrite, isChangingCase, cb);
        mkdirp(path.dirname(dest), (err3) => {
          if (err3) return cb(err3);
          return doRename(src2, dest, overwrite, isChangingCase, cb);
        });
      });
    });
  }
  function isParentRoot(dest) {
    const parent = path.dirname(dest);
    const parsedPath = path.parse(parent);
    return parsedPath.root === parent;
  }
  function doRename(src2, dest, overwrite, isChangingCase, cb) {
    if (isChangingCase) return rename(src2, dest, overwrite, cb);
    if (overwrite) {
      return remove(dest, (err) => {
        if (err) return cb(err);
        return rename(src2, dest, overwrite, cb);
      });
    }
    pathExists(dest, (err, destExists) => {
      if (err) return cb(err);
      if (destExists) return cb(new Error("dest already exists."));
      return rename(src2, dest, overwrite, cb);
    });
  }
  function rename(src2, dest, overwrite, cb) {
    fs2.rename(src2, dest, (err) => {
      if (!err) return cb();
      if (err.code !== "EXDEV") return cb(err);
      return moveAcrossDevice(src2, dest, overwrite, cb);
    });
  }
  function moveAcrossDevice(src2, dest, overwrite, cb) {
    const opts = {
      overwrite,
      errorOnExist: true
    };
    copy2(src2, dest, opts, (err) => {
      if (err) return cb(err);
      return remove(src2, cb);
    });
  }
  move_1 = move2;
  return move_1;
}
var moveSync_1;
var hasRequiredMoveSync;
function requireMoveSync() {
  if (hasRequiredMoveSync) return moveSync_1;
  hasRequiredMoveSync = 1;
  const fs2 = requireGracefulFs();
  const path = require$$1;
  const copySync = requireCopy().copySync;
  const removeSync = requireRemove().removeSync;
  const mkdirpSync = requireMkdirs().mkdirpSync;
  const stat2 = /* @__PURE__ */ requireStat();
  function moveSync(src2, dest, opts) {
    opts = opts || {};
    const overwrite = opts.overwrite || opts.clobber || false;
    const { srcStat, isChangingCase = false } = stat2.checkPathsSync(src2, dest, "move", opts);
    stat2.checkParentPathsSync(src2, srcStat, dest, "move");
    if (!isParentRoot(dest)) mkdirpSync(path.dirname(dest));
    return doRename(src2, dest, overwrite, isChangingCase);
  }
  function isParentRoot(dest) {
    const parent = path.dirname(dest);
    const parsedPath = path.parse(parent);
    return parsedPath.root === parent;
  }
  function doRename(src2, dest, overwrite, isChangingCase) {
    if (isChangingCase) return rename(src2, dest, overwrite);
    if (overwrite) {
      removeSync(dest);
      return rename(src2, dest, overwrite);
    }
    if (fs2.existsSync(dest)) throw new Error("dest already exists.");
    return rename(src2, dest, overwrite);
  }
  function rename(src2, dest, overwrite) {
    try {
      fs2.renameSync(src2, dest);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      return moveAcrossDevice(src2, dest, overwrite);
    }
  }
  function moveAcrossDevice(src2, dest, overwrite) {
    const opts = {
      overwrite,
      errorOnExist: true
    };
    copySync(src2, dest, opts);
    return removeSync(src2);
  }
  moveSync_1 = moveSync;
  return moveSync_1;
}
var move;
var hasRequiredMove;
function requireMove() {
  if (hasRequiredMove) return move;
  hasRequiredMove = 1;
  const u = requireUniversalify().fromCallback;
  move = {
    move: u(/* @__PURE__ */ requireMove$1()),
    moveSync: /* @__PURE__ */ requireMoveSync()
  };
  return move;
}
var lib$1;
var hasRequiredLib$3;
function requireLib$3() {
  if (hasRequiredLib$3) return lib$1;
  hasRequiredLib$3 = 1;
  lib$1 = {
    // Export promiseified graceful-fs:
    .../* @__PURE__ */ requireFs(),
    // Export extra methods:
    .../* @__PURE__ */ requireCopy(),
    .../* @__PURE__ */ requireEmpty(),
    .../* @__PURE__ */ requireEnsure(),
    .../* @__PURE__ */ requireJson(),
    .../* @__PURE__ */ requireMkdirs(),
    .../* @__PURE__ */ requireMove(),
    .../* @__PURE__ */ requireOutputFile(),
    .../* @__PURE__ */ requirePathExists(),
    .../* @__PURE__ */ requireRemove()
  };
  return lib$1;
}
var depTypes = {};
var hasRequiredDepTypes;
function requireDepTypes() {
  if (hasRequiredDepTypes) return depTypes;
  hasRequiredDepTypes = 1;
  (function(exports$1) {
    Object.defineProperty(exports$1, "__esModule", { value: true });
    exports$1.childDepType = exports$1.depTypeGreater = exports$1.DepType = void 0;
    var DepType;
    (function(DepType2) {
      DepType2[DepType2["PROD"] = 0] = "PROD";
      DepType2[DepType2["DEV"] = 1] = "DEV";
      DepType2[DepType2["OPTIONAL"] = 2] = "OPTIONAL";
      DepType2[DepType2["DEV_OPTIONAL"] = 3] = "DEV_OPTIONAL";
      DepType2[DepType2["ROOT"] = 4] = "ROOT";
    })(DepType = exports$1.DepType || (exports$1.DepType = {}));
    const depTypeGreater = (newType, existing) => {
      switch (existing) {
        case DepType.DEV:
          switch (newType) {
            case DepType.OPTIONAL:
            case DepType.PROD:
            case DepType.ROOT:
              return true;
            case DepType.DEV:
            case DepType.DEV_OPTIONAL:
            default:
              return false;
          }
        case DepType.DEV_OPTIONAL:
          switch (newType) {
            case DepType.OPTIONAL:
            case DepType.PROD:
            case DepType.ROOT:
            case DepType.DEV:
              return true;
            case DepType.DEV_OPTIONAL:
            default:
              return false;
          }
        case DepType.OPTIONAL:
          switch (newType) {
            case DepType.PROD:
            case DepType.ROOT:
              return true;
            case DepType.OPTIONAL:
            case DepType.DEV:
            case DepType.DEV_OPTIONAL:
            default:
              return false;
          }
        case DepType.PROD:
          switch (newType) {
            case DepType.ROOT:
              return true;
            case DepType.PROD:
            case DepType.OPTIONAL:
            case DepType.DEV:
            case DepType.DEV_OPTIONAL:
            default:
              return false;
          }
        case DepType.ROOT:
          switch (newType) {
            case DepType.ROOT:
            case DepType.PROD:
            case DepType.OPTIONAL:
            case DepType.DEV:
            case DepType.DEV_OPTIONAL:
            default:
              return false;
          }
        default:
          return false;
      }
    };
    exports$1.depTypeGreater = depTypeGreater;
    const childDepType = (parentType, childType) => {
      if (childType === DepType.ROOT) {
        throw new Error("Something went wrong, a child dependency can't be marked as the ROOT");
      }
      switch (parentType) {
        case DepType.ROOT:
          return childType;
        case DepType.PROD:
          if (childType === DepType.OPTIONAL)
            return DepType.OPTIONAL;
          return DepType.PROD;
        case DepType.OPTIONAL:
          return DepType.OPTIONAL;
        case DepType.DEV_OPTIONAL:
          return DepType.DEV_OPTIONAL;
        case DepType.DEV:
          if (childType === DepType.OPTIONAL)
            return DepType.DEV_OPTIONAL;
          return DepType.DEV;
      }
    };
    exports$1.childDepType = childDepType;
  })(depTypes);
  return depTypes;
}
var nativeModuleTypes = {};
var hasRequiredNativeModuleTypes;
function requireNativeModuleTypes() {
  if (hasRequiredNativeModuleTypes) return nativeModuleTypes;
  hasRequiredNativeModuleTypes = 1;
  (function(exports$1) {
    Object.defineProperty(exports$1, "__esModule", { value: true });
    exports$1.NativeModuleType = void 0;
    (function(NativeModuleType) {
      NativeModuleType[NativeModuleType["NONE"] = 0] = "NONE";
      NativeModuleType[NativeModuleType["NODE_GYP"] = 1] = "NODE_GYP";
      NativeModuleType[NativeModuleType["PREBUILD"] = 2] = "PREBUILD";
    })(exports$1.NativeModuleType || (exports$1.NativeModuleType = {}));
  })(nativeModuleTypes);
  return nativeModuleTypes;
}
var hasRequiredWalker;
function requireWalker() {
  if (hasRequiredWalker) return Walker;
  hasRequiredWalker = 1;
  Object.defineProperty(Walker, "__esModule", { value: true });
  Walker.Walker = void 0;
  const debug = requireSrc();
  const fs2 = /* @__PURE__ */ requireLib$3();
  const path = require$$1;
  const depTypes_1 = requireDepTypes();
  const nativeModuleTypes_1 = requireNativeModuleTypes();
  const d = debug("flora-colossus");
  let Walker$1 = class Walker {
    constructor(modulePath) {
      this.modules = [];
      this.walkHistory = /* @__PURE__ */ new Set();
      this.cache = null;
      if (!modulePath || typeof modulePath !== "string") {
        throw new Error("modulePath must be provided as a string");
      }
      d(`creating walker with rootModule=${modulePath}`);
      this.rootModule = modulePath;
    }
    relativeModule(rootPath, moduleName) {
      return path.resolve(rootPath, "node_modules", moduleName);
    }
    async loadPackageJSON(modulePath) {
      const pJPath = path.resolve(modulePath, "package.json");
      if (await fs2.pathExists(pJPath)) {
        const pJ = await fs2.readJson(pJPath);
        if (!pJ.dependencies)
          pJ.dependencies = {};
        if (!pJ.devDependencies)
          pJ.devDependencies = {};
        if (!pJ.optionalDependencies)
          pJ.optionalDependencies = {};
        return pJ;
      }
      return null;
    }
    async walkDependenciesForModuleInModule(moduleName, modulePath, depType) {
      let testPath = modulePath;
      let discoveredPath = null;
      let lastRelative = null;
      while (!discoveredPath && this.relativeModule(testPath, moduleName) !== lastRelative) {
        lastRelative = this.relativeModule(testPath, moduleName);
        if (await fs2.pathExists(lastRelative)) {
          discoveredPath = lastRelative;
        } else {
          if (path.basename(path.dirname(testPath)) !== "node_modules") {
            testPath = path.dirname(testPath);
          }
          testPath = path.dirname(path.dirname(testPath));
        }
      }
      if (!discoveredPath && depType !== depTypes_1.DepType.OPTIONAL && depType !== depTypes_1.DepType.DEV_OPTIONAL && depType !== depTypes_1.DepType.DEV) {
        throw new Error(`Failed to locate module "${moduleName}" from "${modulePath}"

        This normally means that either you have deleted this package already somehow (check your ignore settings if using electron-packager).  Or your module installation failed.`);
      }
      if (discoveredPath) {
        await this.walkDependenciesForModule(discoveredPath, depType);
      }
    }
    async detectNativeModuleType(modulePath, pJ) {
      if (pJ.dependencies["prebuild-install"]) {
        return nativeModuleTypes_1.NativeModuleType.PREBUILD;
      } else if (await fs2.pathExists(path.join(modulePath, "binding.gyp"))) {
        return nativeModuleTypes_1.NativeModuleType.NODE_GYP;
      }
      return nativeModuleTypes_1.NativeModuleType.NONE;
    }
    async walkDependenciesForModule(modulePath, depType) {
      d("walk reached:", modulePath, " Type is:", depTypes_1.DepType[depType]);
      if (this.walkHistory.has(modulePath)) {
        d("already walked this route");
        const existingModule = this.modules.find((module2) => module2.path === modulePath);
        if ((0, depTypes_1.depTypeGreater)(depType, existingModule.depType)) {
          d(`existing module has a type of "${existingModule.depType}", new module type would be "${depType}" therefore updating`);
          existingModule.depType = depType;
        }
        return;
      }
      const pJ = await this.loadPackageJSON(modulePath);
      if (!pJ) {
        d("walk hit a dead end, this module is incomplete");
        return;
      }
      this.walkHistory.add(modulePath);
      this.modules.push({
        depType,
        nativeModuleType: await this.detectNativeModuleType(modulePath, pJ),
        path: modulePath,
        name: pJ.name
      });
      for (const moduleName in pJ.dependencies) {
        if (moduleName in pJ.optionalDependencies) {
          d(`found ${moduleName} in prod deps of ${modulePath} but it is also marked optional`);
          continue;
        }
        await this.walkDependenciesForModuleInModule(moduleName, modulePath, (0, depTypes_1.childDepType)(depType, depTypes_1.DepType.PROD));
      }
      for (const moduleName in pJ.optionalDependencies) {
        await this.walkDependenciesForModuleInModule(moduleName, modulePath, (0, depTypes_1.childDepType)(depType, depTypes_1.DepType.OPTIONAL));
      }
      if (depType === depTypes_1.DepType.ROOT) {
        d("we're still at the beginning, walking down the dev route");
        for (const moduleName in pJ.devDependencies) {
          await this.walkDependenciesForModuleInModule(moduleName, modulePath, (0, depTypes_1.childDepType)(depType, depTypes_1.DepType.DEV));
        }
      }
    }
    async walkTree() {
      d("starting tree walk");
      if (!this.cache) {
        this.cache = new Promise(async (resolve, reject) => {
          this.modules = [];
          try {
            await this.walkDependenciesForModule(this.rootModule, depTypes_1.DepType.ROOT);
          } catch (err) {
            reject(err);
            return;
          }
          resolve(this.modules);
        });
      } else {
        d("tree walk in progress / completed already, waiting for existing walk to complete");
      }
      return await this.cache;
    }
    getRootModule() {
      return this.rootModule;
    }
  };
  Walker.Walker = Walker$1;
  return Walker;
}
var hasRequiredLib$2;
function requireLib$2() {
  if (hasRequiredLib$2) return lib$2;
  hasRequiredLib$2 = 1;
  (function(exports$1) {
    var __createBinding = lib$2 && lib$2.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __exportStar = lib$2 && lib$2.__exportStar || function(m, exports$12) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$12, p)) __createBinding(exports$12, m, p);
    };
    Object.defineProperty(exports$1, "__esModule", { value: true });
    __exportStar(requireWalker(), exports$1);
    __exportStar(requireDepTypes(), exports$1);
  })(lib$2);
  return lib$2;
}
var hasRequiredDestroyerOfModules;
function requireDestroyerOfModules() {
  if (hasRequiredDestroyerOfModules) return DestroyerOfModules;
  hasRequiredDestroyerOfModules = 1;
  Object.defineProperty(DestroyerOfModules, "__esModule", { value: true });
  DestroyerOfModules.DestroyerOfModules = void 0;
  const fs2 = /* @__PURE__ */ requireLib$4();
  const path = require$$1;
  const flora_colossus_1 = requireLib$2();
  let DestroyerOfModules$1 = class DestroyerOfModules {
    constructor({ rootDirectory, walker, shouldKeepModuleTest }) {
      if (rootDirectory) {
        this.walker = new flora_colossus_1.Walker(rootDirectory);
      } else if (walker) {
        this.walker = walker;
      } else {
        throw new Error("Must either provide rootDirectory or walker argument");
      }
      if (shouldKeepModuleTest) {
        this.shouldKeepFn = shouldKeepModuleTest;
      }
    }
    async destroyModule(modulePath, moduleMap) {
      const module2 = moduleMap.get(modulePath);
      if (module2) {
        const nodeModulesPath = path.resolve(modulePath, "node_modules");
        if (!await fs2.pathExists(nodeModulesPath)) {
          return;
        }
        for (const subModuleName of await fs2.readdir(nodeModulesPath)) {
          if (subModuleName.startsWith("@")) {
            for (const subScopedModuleName of await fs2.readdir(path.resolve(nodeModulesPath, subModuleName))) {
              await this.destroyModule(path.resolve(nodeModulesPath, subModuleName, subScopedModuleName), moduleMap);
            }
          } else {
            await this.destroyModule(path.resolve(nodeModulesPath, subModuleName), moduleMap);
          }
        }
      } else {
        await fs2.remove(modulePath);
      }
    }
    async collectKeptModules({ relativePaths = false }) {
      const modules = await this.walker.walkTree();
      const moduleMap = /* @__PURE__ */ new Map();
      const rootPath = path.resolve(this.walker.getRootModule());
      for (const module2 of modules) {
        if (this.shouldKeepModule(module2)) {
          let modulePath = module2.path;
          if (relativePaths) {
            modulePath = modulePath.replace(`${rootPath}${path.sep}`, "");
          }
          moduleMap.set(modulePath, module2);
        }
      }
      return moduleMap;
    }
    async destroy() {
      await this.destroyModule(this.walker.getRootModule(), await this.collectKeptModules({ relativePaths: false }));
    }
    shouldKeepModule(module2) {
      const isDevDep = module2.depType === flora_colossus_1.DepType.DEV || module2.depType === flora_colossus_1.DepType.DEV_OPTIONAL;
      const shouldKeep = this.shouldKeepFn ? this.shouldKeepFn(module2, isDevDep) : !isDevDep;
      return shouldKeep;
    }
  };
  DestroyerOfModules.DestroyerOfModules = DestroyerOfModules$1;
  return DestroyerOfModules;
}
var hasRequiredLib$1;
function requireLib$1() {
  if (hasRequiredLib$1) return lib$4;
  hasRequiredLib$1 = 1;
  (function(exports$1) {
    var __createBinding = lib$4 && lib$4.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __exportStar = lib$4 && lib$4.__exportStar || function(m, exports$12) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$12, p)) __createBinding(exports$12, m, p);
    };
    Object.defineProperty(exports$1, "__esModule", { value: true });
    __exportStar(requireDestroyerOfModules(), exports$1);
    __exportStar(requireLib$2(), exports$1);
  })(lib$4);
  return lib$4;
}
requireLib$1();
var forge$1;
var hasRequiredForge;
function requireForge() {
  if (hasRequiredForge) return forge$1;
  hasRequiredForge = 1;
  forge$1 = {
    // default options
    options: {
      usePureJavaScript: false
    }
  };
  return forge$1;
}
var util = { exports: {} };
var baseN;
var hasRequiredBaseN;
function requireBaseN() {
  if (hasRequiredBaseN) return baseN;
  hasRequiredBaseN = 1;
  var api = {};
  baseN = api;
  var _reverseAlphabets = {};
  api.encode = function(input, alphabet, maxline) {
    if (typeof alphabet !== "string") {
      throw new TypeError('"alphabet" must be a string.');
    }
    if (maxline !== void 0 && typeof maxline !== "number") {
      throw new TypeError('"maxline" must be a number.');
    }
    var output = "";
    if (!(input instanceof Uint8Array)) {
      output = _encodeWithByteBuffer(input, alphabet);
    } else {
      var i = 0;
      var base = alphabet.length;
      var first = alphabet.charAt(0);
      var digits = [0];
      for (i = 0; i < input.length; ++i) {
        for (var j = 0, carry = input[i]; j < digits.length; ++j) {
          carry += digits[j] << 8;
          digits[j] = carry % base;
          carry = carry / base | 0;
        }
        while (carry > 0) {
          digits.push(carry % base);
          carry = carry / base | 0;
        }
      }
      for (i = 0; input[i] === 0 && i < input.length - 1; ++i) {
        output += first;
      }
      for (i = digits.length - 1; i >= 0; --i) {
        output += alphabet[digits[i]];
      }
    }
    if (maxline) {
      var regex = new RegExp(".{1," + maxline + "}", "g");
      output = output.match(regex).join("\r\n");
    }
    return output;
  };
  api.decode = function(input, alphabet) {
    if (typeof input !== "string") {
      throw new TypeError('"input" must be a string.');
    }
    if (typeof alphabet !== "string") {
      throw new TypeError('"alphabet" must be a string.');
    }
    var table = _reverseAlphabets[alphabet];
    if (!table) {
      table = _reverseAlphabets[alphabet] = [];
      for (var i = 0; i < alphabet.length; ++i) {
        table[alphabet.charCodeAt(i)] = i;
      }
    }
    input = input.replace(/\s/g, "");
    var base = alphabet.length;
    var first = alphabet.charAt(0);
    var bytes = [0];
    for (var i = 0; i < input.length; i++) {
      var value = table[input.charCodeAt(i)];
      if (value === void 0) {
        return;
      }
      for (var j = 0, carry = value; j < bytes.length; ++j) {
        carry += bytes[j] * base;
        bytes[j] = carry & 255;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 255);
        carry >>= 8;
      }
    }
    for (var k = 0; input[k] === first && k < input.length - 1; ++k) {
      bytes.push(0);
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes.reverse());
    }
    return new Uint8Array(bytes.reverse());
  };
  function _encodeWithByteBuffer(input, alphabet) {
    var i = 0;
    var base = alphabet.length;
    var first = alphabet.charAt(0);
    var digits = [0];
    for (i = 0; i < input.length(); ++i) {
      for (var j = 0, carry = input.at(i); j < digits.length; ++j) {
        carry += digits[j] << 8;
        digits[j] = carry % base;
        carry = carry / base | 0;
      }
      while (carry > 0) {
        digits.push(carry % base);
        carry = carry / base | 0;
      }
    }
    var output = "";
    for (i = 0; input.at(i) === 0 && i < input.length() - 1; ++i) {
      output += first;
    }
    for (i = digits.length - 1; i >= 0; --i) {
      output += alphabet[digits[i]];
    }
    return output;
  }
  return baseN;
}
var hasRequiredUtil;
function requireUtil() {
  if (hasRequiredUtil) return util.exports;
  hasRequiredUtil = 1;
  var forge2 = requireForge();
  var baseN2 = requireBaseN();
  var util$12 = util.exports = forge2.util = forge2.util || {};
  (function() {
    if (typeof process !== "undefined" && process.nextTick && !process.browser) {
      util$12.nextTick = process.nextTick;
      if (typeof setImmediate === "function") {
        util$12.setImmediate = setImmediate;
      } else {
        util$12.setImmediate = util$12.nextTick;
      }
      return;
    }
    if (typeof setImmediate === "function") {
      util$12.setImmediate = function() {
        return setImmediate.apply(void 0, arguments);
      };
      util$12.nextTick = function(callback) {
        return setImmediate(callback);
      };
      return;
    }
    util$12.setImmediate = function(callback) {
      setTimeout(callback, 0);
    };
    if (typeof window !== "undefined" && typeof window.postMessage === "function") {
      let handler = function(event) {
        if (event.source === window && event.data === msg) {
          event.stopPropagation();
          var copy2 = callbacks.slice();
          callbacks.length = 0;
          copy2.forEach(function(callback) {
            callback();
          });
        }
      };
      var msg = "forge.setImmediate";
      var callbacks = [];
      util$12.setImmediate = function(callback) {
        callbacks.push(callback);
        if (callbacks.length === 1) {
          window.postMessage(msg, "*");
        }
      };
      window.addEventListener("message", handler, true);
    }
    if (typeof MutationObserver !== "undefined") {
      var now = Date.now();
      var attr = true;
      var div = document.createElement("div");
      var callbacks = [];
      new MutationObserver(function() {
        var copy2 = callbacks.slice();
        callbacks.length = 0;
        copy2.forEach(function(callback) {
          callback();
        });
      }).observe(div, { attributes: true });
      var oldSetImmediate = util$12.setImmediate;
      util$12.setImmediate = function(callback) {
        if (Date.now() - now > 15) {
          now = Date.now();
          oldSetImmediate(callback);
        } else {
          callbacks.push(callback);
          if (callbacks.length === 1) {
            div.setAttribute("a", attr = !attr);
          }
        }
      };
    }
    util$12.nextTick = util$12.setImmediate;
  })();
  util$12.isNodejs = typeof process !== "undefined" && process.versions && process.versions.node;
  util$12.globalScope = function() {
    if (util$12.isNodejs) {
      return heavyWorkWorker.commonjsGlobal;
    }
    return typeof self === "undefined" ? window : self;
  }();
  util$12.isArray = Array.isArray || function(x) {
    return Object.prototype.toString.call(x) === "[object Array]";
  };
  util$12.isArrayBuffer = function(x) {
    return typeof ArrayBuffer !== "undefined" && x instanceof ArrayBuffer;
  };
  util$12.isArrayBufferView = function(x) {
    return x && util$12.isArrayBuffer(x.buffer) && x.byteLength !== void 0;
  };
  function _checkBitsParam(n) {
    if (!(n === 8 || n === 16 || n === 24 || n === 32)) {
      throw new Error("Only 8, 16, 24, or 32 bits supported: " + n);
    }
  }
  util$12.ByteBuffer = ByteStringBuffer;
  function ByteStringBuffer(b) {
    this.data = "";
    this.read = 0;
    if (typeof b === "string") {
      this.data = b;
    } else if (util$12.isArrayBuffer(b) || util$12.isArrayBufferView(b)) {
      if (typeof Buffer !== "undefined" && b instanceof Buffer) {
        this.data = b.toString("binary");
      } else {
        var arr = new Uint8Array(b);
        try {
          this.data = String.fromCharCode.apply(null, arr);
        } catch (e) {
          for (var i = 0; i < arr.length; ++i) {
            this.putByte(arr[i]);
          }
        }
      }
    } else if (b instanceof ByteStringBuffer || typeof b === "object" && typeof b.data === "string" && typeof b.read === "number") {
      this.data = b.data;
      this.read = b.read;
    }
    this._constructedStringLength = 0;
  }
  util$12.ByteStringBuffer = ByteStringBuffer;
  var _MAX_CONSTRUCTED_STRING_LENGTH = 4096;
  util$12.ByteStringBuffer.prototype._optimizeConstructedString = function(x) {
    this._constructedStringLength += x;
    if (this._constructedStringLength > _MAX_CONSTRUCTED_STRING_LENGTH) {
      this.data.substr(0, 1);
      this._constructedStringLength = 0;
    }
  };
  util$12.ByteStringBuffer.prototype.length = function() {
    return this.data.length - this.read;
  };
  util$12.ByteStringBuffer.prototype.isEmpty = function() {
    return this.length() <= 0;
  };
  util$12.ByteStringBuffer.prototype.putByte = function(b) {
    return this.putBytes(String.fromCharCode(b));
  };
  util$12.ByteStringBuffer.prototype.fillWithByte = function(b, n) {
    b = String.fromCharCode(b);
    var d = this.data;
    while (n > 0) {
      if (n & 1) {
        d += b;
      }
      n >>>= 1;
      if (n > 0) {
        b += b;
      }
    }
    this.data = d;
    this._optimizeConstructedString(n);
    return this;
  };
  util$12.ByteStringBuffer.prototype.putBytes = function(bytes) {
    this.data += bytes;
    this._optimizeConstructedString(bytes.length);
    return this;
  };
  util$12.ByteStringBuffer.prototype.putString = function(str) {
    return this.putBytes(util$12.encodeUtf8(str));
  };
  util$12.ByteStringBuffer.prototype.putInt16 = function(i) {
    return this.putBytes(
      String.fromCharCode(i >> 8 & 255) + String.fromCharCode(i & 255)
    );
  };
  util$12.ByteStringBuffer.prototype.putInt24 = function(i) {
    return this.putBytes(
      String.fromCharCode(i >> 16 & 255) + String.fromCharCode(i >> 8 & 255) + String.fromCharCode(i & 255)
    );
  };
  util$12.ByteStringBuffer.prototype.putInt32 = function(i) {
    return this.putBytes(
      String.fromCharCode(i >> 24 & 255) + String.fromCharCode(i >> 16 & 255) + String.fromCharCode(i >> 8 & 255) + String.fromCharCode(i & 255)
    );
  };
  util$12.ByteStringBuffer.prototype.putInt16Le = function(i) {
    return this.putBytes(
      String.fromCharCode(i & 255) + String.fromCharCode(i >> 8 & 255)
    );
  };
  util$12.ByteStringBuffer.prototype.putInt24Le = function(i) {
    return this.putBytes(
      String.fromCharCode(i & 255) + String.fromCharCode(i >> 8 & 255) + String.fromCharCode(i >> 16 & 255)
    );
  };
  util$12.ByteStringBuffer.prototype.putInt32Le = function(i) {
    return this.putBytes(
      String.fromCharCode(i & 255) + String.fromCharCode(i >> 8 & 255) + String.fromCharCode(i >> 16 & 255) + String.fromCharCode(i >> 24 & 255)
    );
  };
  util$12.ByteStringBuffer.prototype.putInt = function(i, n) {
    _checkBitsParam(n);
    var bytes = "";
    do {
      n -= 8;
      bytes += String.fromCharCode(i >> n & 255);
    } while (n > 0);
    return this.putBytes(bytes);
  };
  util$12.ByteStringBuffer.prototype.putSignedInt = function(i, n) {
    if (i < 0) {
      i += 2 << n - 1;
    }
    return this.putInt(i, n);
  };
  util$12.ByteStringBuffer.prototype.putBuffer = function(buffer) {
    return this.putBytes(buffer.getBytes());
  };
  util$12.ByteStringBuffer.prototype.getByte = function() {
    return this.data.charCodeAt(this.read++);
  };
  util$12.ByteStringBuffer.prototype.getInt16 = function() {
    var rval = this.data.charCodeAt(this.read) << 8 ^ this.data.charCodeAt(this.read + 1);
    this.read += 2;
    return rval;
  };
  util$12.ByteStringBuffer.prototype.getInt24 = function() {
    var rval = this.data.charCodeAt(this.read) << 16 ^ this.data.charCodeAt(this.read + 1) << 8 ^ this.data.charCodeAt(this.read + 2);
    this.read += 3;
    return rval;
  };
  util$12.ByteStringBuffer.prototype.getInt32 = function() {
    var rval = this.data.charCodeAt(this.read) << 24 ^ this.data.charCodeAt(this.read + 1) << 16 ^ this.data.charCodeAt(this.read + 2) << 8 ^ this.data.charCodeAt(this.read + 3);
    this.read += 4;
    return rval;
  };
  util$12.ByteStringBuffer.prototype.getInt16Le = function() {
    var rval = this.data.charCodeAt(this.read) ^ this.data.charCodeAt(this.read + 1) << 8;
    this.read += 2;
    return rval;
  };
  util$12.ByteStringBuffer.prototype.getInt24Le = function() {
    var rval = this.data.charCodeAt(this.read) ^ this.data.charCodeAt(this.read + 1) << 8 ^ this.data.charCodeAt(this.read + 2) << 16;
    this.read += 3;
    return rval;
  };
  util$12.ByteStringBuffer.prototype.getInt32Le = function() {
    var rval = this.data.charCodeAt(this.read) ^ this.data.charCodeAt(this.read + 1) << 8 ^ this.data.charCodeAt(this.read + 2) << 16 ^ this.data.charCodeAt(this.read + 3) << 24;
    this.read += 4;
    return rval;
  };
  util$12.ByteStringBuffer.prototype.getInt = function(n) {
    _checkBitsParam(n);
    var rval = 0;
    do {
      rval = (rval << 8) + this.data.charCodeAt(this.read++);
      n -= 8;
    } while (n > 0);
    return rval;
  };
  util$12.ByteStringBuffer.prototype.getSignedInt = function(n) {
    var x = this.getInt(n);
    var max = 2 << n - 2;
    if (x >= max) {
      x -= max << 1;
    }
    return x;
  };
  util$12.ByteStringBuffer.prototype.getBytes = function(count) {
    var rval;
    if (count) {
      count = Math.min(this.length(), count);
      rval = this.data.slice(this.read, this.read + count);
      this.read += count;
    } else if (count === 0) {
      rval = "";
    } else {
      rval = this.read === 0 ? this.data : this.data.slice(this.read);
      this.clear();
    }
    return rval;
  };
  util$12.ByteStringBuffer.prototype.bytes = function(count) {
    return typeof count === "undefined" ? this.data.slice(this.read) : this.data.slice(this.read, this.read + count);
  };
  util$12.ByteStringBuffer.prototype.at = function(i) {
    return this.data.charCodeAt(this.read + i);
  };
  util$12.ByteStringBuffer.prototype.setAt = function(i, b) {
    this.data = this.data.substr(0, this.read + i) + String.fromCharCode(b) + this.data.substr(this.read + i + 1);
    return this;
  };
  util$12.ByteStringBuffer.prototype.last = function() {
    return this.data.charCodeAt(this.data.length - 1);
  };
  util$12.ByteStringBuffer.prototype.copy = function() {
    var c = util$12.createBuffer(this.data);
    c.read = this.read;
    return c;
  };
  util$12.ByteStringBuffer.prototype.compact = function() {
    if (this.read > 0) {
      this.data = this.data.slice(this.read);
      this.read = 0;
    }
    return this;
  };
  util$12.ByteStringBuffer.prototype.clear = function() {
    this.data = "";
    this.read = 0;
    return this;
  };
  util$12.ByteStringBuffer.prototype.truncate = function(count) {
    var len = Math.max(0, this.length() - count);
    this.data = this.data.substr(this.read, len);
    this.read = 0;
    return this;
  };
  util$12.ByteStringBuffer.prototype.toHex = function() {
    var rval = "";
    for (var i = this.read; i < this.data.length; ++i) {
      var b = this.data.charCodeAt(i);
      if (b < 16) {
        rval += "0";
      }
      rval += b.toString(16);
    }
    return rval;
  };
  util$12.ByteStringBuffer.prototype.toString = function() {
    return util$12.decodeUtf8(this.bytes());
  };
  function DataBuffer(b, options) {
    options = options || {};
    this.read = options.readOffset || 0;
    this.growSize = options.growSize || 1024;
    var isArrayBuffer = util$12.isArrayBuffer(b);
    var isArrayBufferView = util$12.isArrayBufferView(b);
    if (isArrayBuffer || isArrayBufferView) {
      if (isArrayBuffer) {
        this.data = new DataView(b);
      } else {
        this.data = new DataView(b.buffer, b.byteOffset, b.byteLength);
      }
      this.write = "writeOffset" in options ? options.writeOffset : this.data.byteLength;
      return;
    }
    this.data = new DataView(new ArrayBuffer(0));
    this.write = 0;
    if (b !== null && b !== void 0) {
      this.putBytes(b);
    }
    if ("writeOffset" in options) {
      this.write = options.writeOffset;
    }
  }
  util$12.DataBuffer = DataBuffer;
  util$12.DataBuffer.prototype.length = function() {
    return this.write - this.read;
  };
  util$12.DataBuffer.prototype.isEmpty = function() {
    return this.length() <= 0;
  };
  util$12.DataBuffer.prototype.accommodate = function(amount, growSize) {
    if (this.length() >= amount) {
      return this;
    }
    growSize = Math.max(growSize || this.growSize, amount);
    var src2 = new Uint8Array(
      this.data.buffer,
      this.data.byteOffset,
      this.data.byteLength
    );
    var dst = new Uint8Array(this.length() + growSize);
    dst.set(src2);
    this.data = new DataView(dst.buffer);
    return this;
  };
  util$12.DataBuffer.prototype.putByte = function(b) {
    this.accommodate(1);
    this.data.setUint8(this.write++, b);
    return this;
  };
  util$12.DataBuffer.prototype.fillWithByte = function(b, n) {
    this.accommodate(n);
    for (var i = 0; i < n; ++i) {
      this.data.setUint8(b);
    }
    return this;
  };
  util$12.DataBuffer.prototype.putBytes = function(bytes, encoding) {
    if (util$12.isArrayBufferView(bytes)) {
      var src2 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var len = src2.byteLength - src2.byteOffset;
      this.accommodate(len);
      var dst = new Uint8Array(this.data.buffer, this.write);
      dst.set(src2);
      this.write += len;
      return this;
    }
    if (util$12.isArrayBuffer(bytes)) {
      var src2 = new Uint8Array(bytes);
      this.accommodate(src2.byteLength);
      var dst = new Uint8Array(this.data.buffer);
      dst.set(src2, this.write);
      this.write += src2.byteLength;
      return this;
    }
    if (bytes instanceof util$12.DataBuffer || typeof bytes === "object" && typeof bytes.read === "number" && typeof bytes.write === "number" && util$12.isArrayBufferView(bytes.data)) {
      var src2 = new Uint8Array(bytes.data.byteLength, bytes.read, bytes.length());
      this.accommodate(src2.byteLength);
      var dst = new Uint8Array(bytes.data.byteLength, this.write);
      dst.set(src2);
      this.write += src2.byteLength;
      return this;
    }
    if (bytes instanceof util$12.ByteStringBuffer) {
      bytes = bytes.data;
      encoding = "binary";
    }
    encoding = encoding || "binary";
    if (typeof bytes === "string") {
      var view;
      if (encoding === "hex") {
        this.accommodate(Math.ceil(bytes.length / 2));
        view = new Uint8Array(this.data.buffer, this.write);
        this.write += util$12.binary.hex.decode(bytes, view, this.write);
        return this;
      }
      if (encoding === "base64") {
        this.accommodate(Math.ceil(bytes.length / 4) * 3);
        view = new Uint8Array(this.data.buffer, this.write);
        this.write += util$12.binary.base64.decode(bytes, view, this.write);
        return this;
      }
      if (encoding === "utf8") {
        bytes = util$12.encodeUtf8(bytes);
        encoding = "binary";
      }
      if (encoding === "binary" || encoding === "raw") {
        this.accommodate(bytes.length);
        view = new Uint8Array(this.data.buffer, this.write);
        this.write += util$12.binary.raw.decode(view);
        return this;
      }
      if (encoding === "utf16") {
        this.accommodate(bytes.length * 2);
        view = new Uint16Array(this.data.buffer, this.write);
        this.write += util$12.text.utf16.encode(view);
        return this;
      }
      throw new Error("Invalid encoding: " + encoding);
    }
    throw Error("Invalid parameter: " + bytes);
  };
  util$12.DataBuffer.prototype.putBuffer = function(buffer) {
    this.putBytes(buffer);
    buffer.clear();
    return this;
  };
  util$12.DataBuffer.prototype.putString = function(str) {
    return this.putBytes(str, "utf16");
  };
  util$12.DataBuffer.prototype.putInt16 = function(i) {
    this.accommodate(2);
    this.data.setInt16(this.write, i);
    this.write += 2;
    return this;
  };
  util$12.DataBuffer.prototype.putInt24 = function(i) {
    this.accommodate(3);
    this.data.setInt16(this.write, i >> 8 & 65535);
    this.data.setInt8(this.write, i >> 16 & 255);
    this.write += 3;
    return this;
  };
  util$12.DataBuffer.prototype.putInt32 = function(i) {
    this.accommodate(4);
    this.data.setInt32(this.write, i);
    this.write += 4;
    return this;
  };
  util$12.DataBuffer.prototype.putInt16Le = function(i) {
    this.accommodate(2);
    this.data.setInt16(this.write, i, true);
    this.write += 2;
    return this;
  };
  util$12.DataBuffer.prototype.putInt24Le = function(i) {
    this.accommodate(3);
    this.data.setInt8(this.write, i >> 16 & 255);
    this.data.setInt16(this.write, i >> 8 & 65535, true);
    this.write += 3;
    return this;
  };
  util$12.DataBuffer.prototype.putInt32Le = function(i) {
    this.accommodate(4);
    this.data.setInt32(this.write, i, true);
    this.write += 4;
    return this;
  };
  util$12.DataBuffer.prototype.putInt = function(i, n) {
    _checkBitsParam(n);
    this.accommodate(n / 8);
    do {
      n -= 8;
      this.data.setInt8(this.write++, i >> n & 255);
    } while (n > 0);
    return this;
  };
  util$12.DataBuffer.prototype.putSignedInt = function(i, n) {
    _checkBitsParam(n);
    this.accommodate(n / 8);
    if (i < 0) {
      i += 2 << n - 1;
    }
    return this.putInt(i, n);
  };
  util$12.DataBuffer.prototype.getByte = function() {
    return this.data.getInt8(this.read++);
  };
  util$12.DataBuffer.prototype.getInt16 = function() {
    var rval = this.data.getInt16(this.read);
    this.read += 2;
    return rval;
  };
  util$12.DataBuffer.prototype.getInt24 = function() {
    var rval = this.data.getInt16(this.read) << 8 ^ this.data.getInt8(this.read + 2);
    this.read += 3;
    return rval;
  };
  util$12.DataBuffer.prototype.getInt32 = function() {
    var rval = this.data.getInt32(this.read);
    this.read += 4;
    return rval;
  };
  util$12.DataBuffer.prototype.getInt16Le = function() {
    var rval = this.data.getInt16(this.read, true);
    this.read += 2;
    return rval;
  };
  util$12.DataBuffer.prototype.getInt24Le = function() {
    var rval = this.data.getInt8(this.read) ^ this.data.getInt16(this.read + 1, true) << 8;
    this.read += 3;
    return rval;
  };
  util$12.DataBuffer.prototype.getInt32Le = function() {
    var rval = this.data.getInt32(this.read, true);
    this.read += 4;
    return rval;
  };
  util$12.DataBuffer.prototype.getInt = function(n) {
    _checkBitsParam(n);
    var rval = 0;
    do {
      rval = (rval << 8) + this.data.getInt8(this.read++);
      n -= 8;
    } while (n > 0);
    return rval;
  };
  util$12.DataBuffer.prototype.getSignedInt = function(n) {
    var x = this.getInt(n);
    var max = 2 << n - 2;
    if (x >= max) {
      x -= max << 1;
    }
    return x;
  };
  util$12.DataBuffer.prototype.getBytes = function(count) {
    var rval;
    if (count) {
      count = Math.min(this.length(), count);
      rval = this.data.slice(this.read, this.read + count);
      this.read += count;
    } else if (count === 0) {
      rval = "";
    } else {
      rval = this.read === 0 ? this.data : this.data.slice(this.read);
      this.clear();
    }
    return rval;
  };
  util$12.DataBuffer.prototype.bytes = function(count) {
    return typeof count === "undefined" ? this.data.slice(this.read) : this.data.slice(this.read, this.read + count);
  };
  util$12.DataBuffer.prototype.at = function(i) {
    return this.data.getUint8(this.read + i);
  };
  util$12.DataBuffer.prototype.setAt = function(i, b) {
    this.data.setUint8(i, b);
    return this;
  };
  util$12.DataBuffer.prototype.last = function() {
    return this.data.getUint8(this.write - 1);
  };
  util$12.DataBuffer.prototype.copy = function() {
    return new util$12.DataBuffer(this);
  };
  util$12.DataBuffer.prototype.compact = function() {
    if (this.read > 0) {
      var src2 = new Uint8Array(this.data.buffer, this.read);
      var dst = new Uint8Array(src2.byteLength);
      dst.set(src2);
      this.data = new DataView(dst);
      this.write -= this.read;
      this.read = 0;
    }
    return this;
  };
  util$12.DataBuffer.prototype.clear = function() {
    this.data = new DataView(new ArrayBuffer(0));
    this.read = this.write = 0;
    return this;
  };
  util$12.DataBuffer.prototype.truncate = function(count) {
    this.write = Math.max(0, this.length() - count);
    this.read = Math.min(this.read, this.write);
    return this;
  };
  util$12.DataBuffer.prototype.toHex = function() {
    var rval = "";
    for (var i = this.read; i < this.data.byteLength; ++i) {
      var b = this.data.getUint8(i);
      if (b < 16) {
        rval += "0";
      }
      rval += b.toString(16);
    }
    return rval;
  };
  util$12.DataBuffer.prototype.toString = function(encoding) {
    var view = new Uint8Array(this.data, this.read, this.length());
    encoding = encoding || "utf8";
    if (encoding === "binary" || encoding === "raw") {
      return util$12.binary.raw.encode(view);
    }
    if (encoding === "hex") {
      return util$12.binary.hex.encode(view);
    }
    if (encoding === "base64") {
      return util$12.binary.base64.encode(view);
    }
    if (encoding === "utf8") {
      return util$12.text.utf8.decode(view);
    }
    if (encoding === "utf16") {
      return util$12.text.utf16.decode(view);
    }
    throw new Error("Invalid encoding: " + encoding);
  };
  util$12.createBuffer = function(input, encoding) {
    encoding = encoding || "raw";
    if (input !== void 0 && encoding === "utf8") {
      input = util$12.encodeUtf8(input);
    }
    return new util$12.ByteBuffer(input);
  };
  util$12.fillString = function(c, n) {
    var s = "";
    while (n > 0) {
      if (n & 1) {
        s += c;
      }
      n >>>= 1;
      if (n > 0) {
        c += c;
      }
    }
    return s;
  };
  util$12.xorBytes = function(s1, s2, n) {
    var s3 = "";
    var b = "";
    var t = "";
    var i = 0;
    var c = 0;
    for (; n > 0; --n, ++i) {
      b = s1.charCodeAt(i) ^ s2.charCodeAt(i);
      if (c >= 10) {
        s3 += t;
        t = "";
        c = 0;
      }
      t += String.fromCharCode(b);
      ++c;
    }
    s3 += t;
    return s3;
  };
  util$12.hexToBytes = function(hex) {
    var rval = "";
    var i = 0;
    if (hex.length & true) {
      i = 1;
      rval += String.fromCharCode(parseInt(hex[0], 16));
    }
    for (; i < hex.length; i += 2) {
      rval += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return rval;
  };
  util$12.bytesToHex = function(bytes) {
    return util$12.createBuffer(bytes).toHex();
  };
  util$12.int32ToBytes = function(i) {
    return String.fromCharCode(i >> 24 & 255) + String.fromCharCode(i >> 16 & 255) + String.fromCharCode(i >> 8 & 255) + String.fromCharCode(i & 255);
  };
  var _base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  var _base64Idx = [
    /*43 -43 = 0*/
    /*'+',  1,  2,  3,'/' */
    62,
    -1,
    -1,
    -1,
    63,
    /*'0','1','2','3','4','5','6','7','8','9' */
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    /*15, 16, 17,'=', 19, 20, 21 */
    -1,
    -1,
    -1,
    64,
    -1,
    -1,
    -1,
    /*65 - 43 = 22*/
    /*'A','B','C','D','E','F','G','H','I','J','K','L','M', */
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    /*'N','O','P','Q','R','S','T','U','V','W','X','Y','Z' */
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    /*91 - 43 = 48 */
    /*48, 49, 50, 51, 52, 53 */
    -1,
    -1,
    -1,
    -1,
    -1,
    -1,
    /*97 - 43 = 54*/
    /*'a','b','c','d','e','f','g','h','i','j','k','l','m' */
    26,
    27,
    28,
    29,
    30,
    31,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    /*'n','o','p','q','r','s','t','u','v','w','x','y','z' */
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51
  ];
  var _base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  util$12.encode64 = function(input, maxline) {
    var line = "";
    var output = "";
    var chr1, chr2, chr3;
    var i = 0;
    while (i < input.length) {
      chr1 = input.charCodeAt(i++);
      chr2 = input.charCodeAt(i++);
      chr3 = input.charCodeAt(i++);
      line += _base64.charAt(chr1 >> 2);
      line += _base64.charAt((chr1 & 3) << 4 | chr2 >> 4);
      if (isNaN(chr2)) {
        line += "==";
      } else {
        line += _base64.charAt((chr2 & 15) << 2 | chr3 >> 6);
        line += isNaN(chr3) ? "=" : _base64.charAt(chr3 & 63);
      }
      if (maxline && line.length > maxline) {
        output += line.substr(0, maxline) + "\r\n";
        line = line.substr(maxline);
      }
    }
    output += line;
    return output;
  };
  util$12.decode64 = function(input) {
    input = input.replace(/[^A-Za-z0-9\+\/\=]/g, "");
    var output = "";
    var enc1, enc2, enc3, enc4;
    var i = 0;
    while (i < input.length) {
      enc1 = _base64Idx[input.charCodeAt(i++) - 43];
      enc2 = _base64Idx[input.charCodeAt(i++) - 43];
      enc3 = _base64Idx[input.charCodeAt(i++) - 43];
      enc4 = _base64Idx[input.charCodeAt(i++) - 43];
      output += String.fromCharCode(enc1 << 2 | enc2 >> 4);
      if (enc3 !== 64) {
        output += String.fromCharCode((enc2 & 15) << 4 | enc3 >> 2);
        if (enc4 !== 64) {
          output += String.fromCharCode((enc3 & 3) << 6 | enc4);
        }
      }
    }
    return output;
  };
  util$12.encodeUtf8 = function(str) {
    return unescape(encodeURIComponent(str));
  };
  util$12.decodeUtf8 = function(str) {
    return decodeURIComponent(escape(str));
  };
  util$12.binary = {
    raw: {},
    hex: {},
    base64: {},
    base58: {},
    baseN: {
      encode: baseN2.encode,
      decode: baseN2.decode
    }
  };
  util$12.binary.raw.encode = function(bytes) {
    return String.fromCharCode.apply(null, bytes);
  };
  util$12.binary.raw.decode = function(str, output, offset) {
    var out = output;
    if (!out) {
      out = new Uint8Array(str.length);
    }
    offset = offset || 0;
    var j = offset;
    for (var i = 0; i < str.length; ++i) {
      out[j++] = str.charCodeAt(i);
    }
    return output ? j - offset : out;
  };
  util$12.binary.hex.encode = util$12.bytesToHex;
  util$12.binary.hex.decode = function(hex, output, offset) {
    var out = output;
    if (!out) {
      out = new Uint8Array(Math.ceil(hex.length / 2));
    }
    offset = offset || 0;
    var i = 0, j = offset;
    if (hex.length & 1) {
      i = 1;
      out[j++] = parseInt(hex[0], 16);
    }
    for (; i < hex.length; i += 2) {
      out[j++] = parseInt(hex.substr(i, 2), 16);
    }
    return output ? j - offset : out;
  };
  util$12.binary.base64.encode = function(input, maxline) {
    var line = "";
    var output = "";
    var chr1, chr2, chr3;
    var i = 0;
    while (i < input.byteLength) {
      chr1 = input[i++];
      chr2 = input[i++];
      chr3 = input[i++];
      line += _base64.charAt(chr1 >> 2);
      line += _base64.charAt((chr1 & 3) << 4 | chr2 >> 4);
      if (isNaN(chr2)) {
        line += "==";
      } else {
        line += _base64.charAt((chr2 & 15) << 2 | chr3 >> 6);
        line += isNaN(chr3) ? "=" : _base64.charAt(chr3 & 63);
      }
      if (maxline && line.length > maxline) {
        output += line.substr(0, maxline) + "\r\n";
        line = line.substr(maxline);
      }
    }
    output += line;
    return output;
  };
  util$12.binary.base64.decode = function(input, output, offset) {
    var out = output;
    if (!out) {
      out = new Uint8Array(Math.ceil(input.length / 4) * 3);
    }
    input = input.replace(/[^A-Za-z0-9\+\/\=]/g, "");
    offset = offset || 0;
    var enc1, enc2, enc3, enc4;
    var i = 0, j = offset;
    while (i < input.length) {
      enc1 = _base64Idx[input.charCodeAt(i++) - 43];
      enc2 = _base64Idx[input.charCodeAt(i++) - 43];
      enc3 = _base64Idx[input.charCodeAt(i++) - 43];
      enc4 = _base64Idx[input.charCodeAt(i++) - 43];
      out[j++] = enc1 << 2 | enc2 >> 4;
      if (enc3 !== 64) {
        out[j++] = (enc2 & 15) << 4 | enc3 >> 2;
        if (enc4 !== 64) {
          out[j++] = (enc3 & 3) << 6 | enc4;
        }
      }
    }
    return output ? j - offset : out.subarray(0, j);
  };
  util$12.binary.base58.encode = function(input, maxline) {
    return util$12.binary.baseN.encode(input, _base58, maxline);
  };
  util$12.binary.base58.decode = function(input, maxline) {
    return util$12.binary.baseN.decode(input, _base58, maxline);
  };
  util$12.text = {
    utf8: {},
    utf16: {}
  };
  util$12.text.utf8.encode = function(str, output, offset) {
    str = util$12.encodeUtf8(str);
    var out = output;
    if (!out) {
      out = new Uint8Array(str.length);
    }
    offset = offset || 0;
    var j = offset;
    for (var i = 0; i < str.length; ++i) {
      out[j++] = str.charCodeAt(i);
    }
    return output ? j - offset : out;
  };
  util$12.text.utf8.decode = function(bytes) {
    return util$12.decodeUtf8(String.fromCharCode.apply(null, bytes));
  };
  util$12.text.utf16.encode = function(str, output, offset) {
    var out = output;
    if (!out) {
      out = new Uint8Array(str.length * 2);
    }
    var view = new Uint16Array(out.buffer);
    offset = offset || 0;
    var j = offset;
    var k = offset;
    for (var i = 0; i < str.length; ++i) {
      view[k++] = str.charCodeAt(i);
      j += 2;
    }
    return output ? j - offset : out;
  };
  util$12.text.utf16.decode = function(bytes) {
    return String.fromCharCode.apply(null, new Uint16Array(bytes.buffer));
  };
  util$12.deflate = function(api, bytes, raw) {
    bytes = util$12.decode64(api.deflate(util$12.encode64(bytes)).rval);
    if (raw) {
      var start = 2;
      var flg = bytes.charCodeAt(1);
      if (flg & 32) {
        start = 6;
      }
      bytes = bytes.substring(start, bytes.length - 4);
    }
    return bytes;
  };
  util$12.inflate = function(api, bytes, raw) {
    var rval = api.inflate(util$12.encode64(bytes)).rval;
    return rval === null ? null : util$12.decode64(rval);
  };
  var _setStorageObject = function(api, id, obj) {
    if (!api) {
      throw new Error("WebStorage not available.");
    }
    var rval;
    if (obj === null) {
      rval = api.removeItem(id);
    } else {
      obj = util$12.encode64(JSON.stringify(obj));
      rval = api.setItem(id, obj);
    }
    if (typeof rval !== "undefined" && rval.rval !== true) {
      var error = new Error(rval.error.message);
      error.id = rval.error.id;
      error.name = rval.error.name;
      throw error;
    }
  };
  var _getStorageObject = function(api, id) {
    if (!api) {
      throw new Error("WebStorage not available.");
    }
    var rval = api.getItem(id);
    if (api.init) {
      if (rval.rval === null) {
        if (rval.error) {
          var error = new Error(rval.error.message);
          error.id = rval.error.id;
          error.name = rval.error.name;
          throw error;
        }
        rval = null;
      } else {
        rval = rval.rval;
      }
    }
    if (rval !== null) {
      rval = JSON.parse(util$12.decode64(rval));
    }
    return rval;
  };
  var _setItem = function(api, id, key, data) {
    var obj = _getStorageObject(api, id);
    if (obj === null) {
      obj = {};
    }
    obj[key] = data;
    _setStorageObject(api, id, obj);
  };
  var _getItem = function(api, id, key) {
    var rval = _getStorageObject(api, id);
    if (rval !== null) {
      rval = key in rval ? rval[key] : null;
    }
    return rval;
  };
  var _removeItem = function(api, id, key) {
    var obj = _getStorageObject(api, id);
    if (obj !== null && key in obj) {
      delete obj[key];
      var empty2 = true;
      for (var prop in obj) {
        empty2 = false;
        break;
      }
      if (empty2) {
        obj = null;
      }
      _setStorageObject(api, id, obj);
    }
  };
  var _clearItems = function(api, id) {
    _setStorageObject(api, id, null);
  };
  var _callStorageFunction = function(func, args, location) {
    var rval = null;
    if (typeof location === "undefined") {
      location = ["web", "flash"];
    }
    var type;
    var done = false;
    var exception = null;
    for (var idx in location) {
      type = location[idx];
      try {
        if (type === "flash" || type === "both") {
          if (args[0] === null) {
            throw new Error("Flash local storage not available.");
          }
          rval = func.apply(this, args);
          done = type === "flash";
        }
        if (type === "web" || type === "both") {
          args[0] = localStorage;
          rval = func.apply(this, args);
          done = true;
        }
      } catch (ex) {
        exception = ex;
      }
      if (done) {
        break;
      }
    }
    if (!done) {
      throw exception;
    }
    return rval;
  };
  util$12.setItem = function(api, id, key, data, location) {
    _callStorageFunction(_setItem, arguments, location);
  };
  util$12.getItem = function(api, id, key, location) {
    return _callStorageFunction(_getItem, arguments, location);
  };
  util$12.removeItem = function(api, id, key, location) {
    _callStorageFunction(_removeItem, arguments, location);
  };
  util$12.clearItems = function(api, id, location) {
    _callStorageFunction(_clearItems, arguments, location);
  };
  util$12.isEmpty = function(obj) {
    for (var prop in obj) {
      if (obj.hasOwnProperty(prop)) {
        return false;
      }
    }
    return true;
  };
  util$12.format = function(format) {
    var re = /%./g;
    var match;
    var part;
    var argi = 0;
    var parts = [];
    var last = 0;
    while (match = re.exec(format)) {
      part = format.substring(last, re.lastIndex - 2);
      if (part.length > 0) {
        parts.push(part);
      }
      last = re.lastIndex;
      var code = match[0][1];
      switch (code) {
        case "s":
        case "o":
          if (argi < arguments.length) {
            parts.push(arguments[argi++ + 1]);
          } else {
            parts.push("<?>");
          }
          break;
        // FIXME: do proper formatting for numbers, etc
        //case 'f':
        //case 'd':
        case "%":
          parts.push("%");
          break;
        default:
          parts.push("<%" + code + "?>");
      }
    }
    parts.push(format.substring(last));
    return parts.join("");
  };
  util$12.formatNumber = function(number, decimals, dec_point, thousands_sep) {
    var n = number, c = isNaN(decimals = Math.abs(decimals)) ? 2 : decimals;
    var d = dec_point === void 0 ? "," : dec_point;
    var t = thousands_sep === void 0 ? "." : thousands_sep, s = n < 0 ? "-" : "";
    var i = parseInt(n = Math.abs(+n || 0).toFixed(c), 10) + "";
    var j = i.length > 3 ? i.length % 3 : 0;
    return s + (j ? i.substr(0, j) + t : "") + i.substr(j).replace(/(\d{3})(?=\d)/g, "$1" + t) + (c ? d + Math.abs(n - i).toFixed(c).slice(2) : "");
  };
  util$12.formatSize = function(size) {
    if (size >= 1073741824) {
      size = util$12.formatNumber(size / 1073741824, 2, ".", "") + " GiB";
    } else if (size >= 1048576) {
      size = util$12.formatNumber(size / 1048576, 2, ".", "") + " MiB";
    } else if (size >= 1024) {
      size = util$12.formatNumber(size / 1024, 0) + " KiB";
    } else {
      size = util$12.formatNumber(size, 0) + " bytes";
    }
    return size;
  };
  util$12.bytesFromIP = function(ip) {
    if (ip.indexOf(".") !== -1) {
      return util$12.bytesFromIPv4(ip);
    }
    if (ip.indexOf(":") !== -1) {
      return util$12.bytesFromIPv6(ip);
    }
    return null;
  };
  util$12.bytesFromIPv4 = function(ip) {
    ip = ip.split(".");
    if (ip.length !== 4) {
      return null;
    }
    var b = util$12.createBuffer();
    for (var i = 0; i < ip.length; ++i) {
      var num = parseInt(ip[i], 10);
      if (isNaN(num)) {
        return null;
      }
      b.putByte(num);
    }
    return b.getBytes();
  };
  util$12.bytesFromIPv6 = function(ip) {
    var blanks = 0;
    ip = ip.split(":").filter(function(e) {
      if (e.length === 0) ++blanks;
      return true;
    });
    var zeros = (8 - ip.length + blanks) * 2;
    var b = util$12.createBuffer();
    for (var i = 0; i < 8; ++i) {
      if (!ip[i] || ip[i].length === 0) {
        b.fillWithByte(0, zeros);
        zeros = 0;
        continue;
      }
      var bytes = util$12.hexToBytes(ip[i]);
      if (bytes.length < 2) {
        b.putByte(0);
      }
      b.putBytes(bytes);
    }
    return b.getBytes();
  };
  util$12.bytesToIP = function(bytes) {
    if (bytes.length === 4) {
      return util$12.bytesToIPv4(bytes);
    }
    if (bytes.length === 16) {
      return util$12.bytesToIPv6(bytes);
    }
    return null;
  };
  util$12.bytesToIPv4 = function(bytes) {
    if (bytes.length !== 4) {
      return null;
    }
    var ip = [];
    for (var i = 0; i < bytes.length; ++i) {
      ip.push(bytes.charCodeAt(i));
    }
    return ip.join(".");
  };
  util$12.bytesToIPv6 = function(bytes) {
    if (bytes.length !== 16) {
      return null;
    }
    var ip = [];
    var zeroGroups = [];
    var zeroMaxGroup = 0;
    for (var i = 0; i < bytes.length; i += 2) {
      var hex = util$12.bytesToHex(bytes[i] + bytes[i + 1]);
      while (hex[0] === "0" && hex !== "0") {
        hex = hex.substr(1);
      }
      if (hex === "0") {
        var last = zeroGroups[zeroGroups.length - 1];
        var idx = ip.length;
        if (!last || idx !== last.end + 1) {
          zeroGroups.push({ start: idx, end: idx });
        } else {
          last.end = idx;
          if (last.end - last.start > zeroGroups[zeroMaxGroup].end - zeroGroups[zeroMaxGroup].start) {
            zeroMaxGroup = zeroGroups.length - 1;
          }
        }
      }
      ip.push(hex);
    }
    if (zeroGroups.length > 0) {
      var group = zeroGroups[zeroMaxGroup];
      if (group.end - group.start > 0) {
        ip.splice(group.start, group.end - group.start + 1, "");
        if (group.start === 0) {
          ip.unshift("");
        }
        if (group.end === 7) {
          ip.push("");
        }
      }
    }
    return ip.join(":");
  };
  util$12.estimateCores = function(options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    options = options || {};
    if ("cores" in util$12 && !options.update) {
      return callback(null, util$12.cores);
    }
    if (typeof navigator !== "undefined" && "hardwareConcurrency" in navigator && navigator.hardwareConcurrency > 0) {
      util$12.cores = navigator.hardwareConcurrency;
      return callback(null, util$12.cores);
    }
    if (typeof Worker === "undefined") {
      util$12.cores = 1;
      return callback(null, util$12.cores);
    }
    if (typeof Blob === "undefined") {
      util$12.cores = 2;
      return callback(null, util$12.cores);
    }
    var blobUrl = URL.createObjectURL(new Blob([
      "(",
      (function() {
        self.addEventListener("message", function(e) {
          var st = Date.now();
          var et = st + 4;
          self.postMessage({ st, et });
        });
      }).toString(),
      ")()"
    ], { type: "application/javascript" }));
    sample([], 5, 16);
    function sample(max, samples, numWorkers) {
      if (samples === 0) {
        var avg = Math.floor(max.reduce(function(avg2, x) {
          return avg2 + x;
        }, 0) / max.length);
        util$12.cores = Math.max(1, avg);
        URL.revokeObjectURL(blobUrl);
        return callback(null, util$12.cores);
      }
      map(numWorkers, function(err, results) {
        max.push(reduce(numWorkers, results));
        sample(max, samples - 1, numWorkers);
      });
    }
    function map(numWorkers, callback2) {
      var workers = [];
      var results = [];
      for (var i = 0; i < numWorkers; ++i) {
        var worker = new Worker(blobUrl);
        worker.addEventListener("message", function(e) {
          results.push(e.data);
          if (results.length === numWorkers) {
            for (var i2 = 0; i2 < numWorkers; ++i2) {
              workers[i2].terminate();
            }
            callback2(null, results);
          }
        });
        workers.push(worker);
      }
      for (var i = 0; i < numWorkers; ++i) {
        workers[i].postMessage(i);
      }
    }
    function reduce(numWorkers, results) {
      var overlaps = [];
      for (var n = 0; n < numWorkers; ++n) {
        var r1 = results[n];
        var overlap = overlaps[n] = [];
        for (var i = 0; i < numWorkers; ++i) {
          if (n === i) {
            continue;
          }
          var r2 = results[i];
          if (r1.st > r2.st && r1.st < r2.et || r2.st > r1.st && r2.st < r1.et) {
            overlap.push(i);
          }
        }
      }
      return overlaps.reduce(function(max, overlap2) {
        return Math.max(max, overlap2.length);
      }, 0);
    }
  };
  return util.exports;
}
var cipher;
var hasRequiredCipher;
function requireCipher() {
  if (hasRequiredCipher) return cipher;
  hasRequiredCipher = 1;
  var forge2 = requireForge();
  requireUtil();
  cipher = forge2.cipher = forge2.cipher || {};
  forge2.cipher.algorithms = forge2.cipher.algorithms || {};
  forge2.cipher.createCipher = function(algorithm, key) {
    var api = algorithm;
    if (typeof api === "string") {
      api = forge2.cipher.getAlgorithm(api);
      if (api) {
        api = api();
      }
    }
    if (!api) {
      throw new Error("Unsupported algorithm: " + algorithm);
    }
    return new forge2.cipher.BlockCipher({
      algorithm: api,
      key,
      decrypt: false
    });
  };
  forge2.cipher.createDecipher = function(algorithm, key) {
    var api = algorithm;
    if (typeof api === "string") {
      api = forge2.cipher.getAlgorithm(api);
      if (api) {
        api = api();
      }
    }
    if (!api) {
      throw new Error("Unsupported algorithm: " + algorithm);
    }
    return new forge2.cipher.BlockCipher({
      algorithm: api,
      key,
      decrypt: true
    });
  };
  forge2.cipher.registerAlgorithm = function(name, algorithm) {
    name = name.toUpperCase();
    forge2.cipher.algorithms[name] = algorithm;
  };
  forge2.cipher.getAlgorithm = function(name) {
    name = name.toUpperCase();
    if (name in forge2.cipher.algorithms) {
      return forge2.cipher.algorithms[name];
    }
    return null;
  };
  var BlockCipher = forge2.cipher.BlockCipher = function(options) {
    this.algorithm = options.algorithm;
    this.mode = this.algorithm.mode;
    this.blockSize = this.mode.blockSize;
    this._finish = false;
    this._input = null;
    this.output = null;
    this._op = options.decrypt ? this.mode.decrypt : this.mode.encrypt;
    this._decrypt = options.decrypt;
    this.algorithm.initialize(options);
  };
  BlockCipher.prototype.start = function(options) {
    options = options || {};
    var opts = {};
    for (var key in options) {
      opts[key] = options[key];
    }
    opts.decrypt = this._decrypt;
    this._finish = false;
    this._input = forge2.util.createBuffer();
    this.output = options.output || forge2.util.createBuffer();
    this.mode.start(opts);
  };
  BlockCipher.prototype.update = function(input) {
    if (input) {
      this._input.putBuffer(input);
    }
    while (!this._op.call(this.mode, this._input, this.output, this._finish) && !this._finish) {
    }
    this._input.compact();
  };
  BlockCipher.prototype.finish = function(pad) {
    if (pad && (this.mode.name === "ECB" || this.mode.name === "CBC")) {
      this.mode.pad = function(input) {
        return pad(this.blockSize, input, false);
      };
      this.mode.unpad = function(output) {
        return pad(this.blockSize, output, true);
      };
    }
    var options = {};
    options.decrypt = this._decrypt;
    options.overflow = this._input.length() % this.blockSize;
    if (!this._decrypt && this.mode.pad) {
      if (!this.mode.pad(this._input, options)) {
        return false;
      }
    }
    this._finish = true;
    this.update();
    if (this._decrypt && this.mode.unpad) {
      if (!this.mode.unpad(this.output, options)) {
        return false;
      }
    }
    if (this.mode.afterFinish) {
      if (!this.mode.afterFinish(this.output, options)) {
        return false;
      }
    }
    return true;
  };
  return cipher;
}
var cipherModes = { exports: {} };
var hasRequiredCipherModes;
function requireCipherModes() {
  if (hasRequiredCipherModes) return cipherModes.exports;
  hasRequiredCipherModes = 1;
  var forge2 = requireForge();
  requireUtil();
  forge2.cipher = forge2.cipher || {};
  var modes = cipherModes.exports = forge2.cipher.modes = forge2.cipher.modes || {};
  modes.ecb = function(options) {
    options = options || {};
    this.name = "ECB";
    this.cipher = options.cipher;
    this.blockSize = options.blockSize || 16;
    this._ints = this.blockSize / 4;
    this._inBlock = new Array(this._ints);
    this._outBlock = new Array(this._ints);
  };
  modes.ecb.prototype.start = function(options) {
  };
  modes.ecb.prototype.encrypt = function(input, output, finish) {
    if (input.length() < this.blockSize && !(finish && input.length() > 0)) {
      return true;
    }
    for (var i = 0; i < this._ints; ++i) {
      this._inBlock[i] = input.getInt32();
    }
    this.cipher.encrypt(this._inBlock, this._outBlock);
    for (var i = 0; i < this._ints; ++i) {
      output.putInt32(this._outBlock[i]);
    }
  };
  modes.ecb.prototype.decrypt = function(input, output, finish) {
    if (input.length() < this.blockSize && !(finish && input.length() > 0)) {
      return true;
    }
    for (var i = 0; i < this._ints; ++i) {
      this._inBlock[i] = input.getInt32();
    }
    this.cipher.decrypt(this._inBlock, this._outBlock);
    for (var i = 0; i < this._ints; ++i) {
      output.putInt32(this._outBlock[i]);
    }
  };
  modes.ecb.prototype.pad = function(input, options) {
    var padding = input.length() === this.blockSize ? this.blockSize : this.blockSize - input.length();
    input.fillWithByte(padding, padding);
    return true;
  };
  modes.ecb.prototype.unpad = function(output, options) {
    if (options.overflow > 0) {
      return false;
    }
    var len = output.length();
    var count = output.at(len - 1);
    if (count > this.blockSize << 2) {
      return false;
    }
    output.truncate(count);
    return true;
  };
  modes.cbc = function(options) {
    options = options || {};
    this.name = "CBC";
    this.cipher = options.cipher;
    this.blockSize = options.blockSize || 16;
    this._ints = this.blockSize / 4;
    this._inBlock = new Array(this._ints);
    this._outBlock = new Array(this._ints);
  };
  modes.cbc.prototype.start = function(options) {
    if (options.iv === null) {
      if (!this._prev) {
        throw new Error("Invalid IV parameter.");
      }
      this._iv = this._prev.slice(0);
    } else if (!("iv" in options)) {
      throw new Error("Invalid IV parameter.");
    } else {
      this._iv = transformIV(options.iv, this.blockSize);
      this._prev = this._iv.slice(0);
    }
  };
  modes.cbc.prototype.encrypt = function(input, output, finish) {
    if (input.length() < this.blockSize && !(finish && input.length() > 0)) {
      return true;
    }
    for (var i = 0; i < this._ints; ++i) {
      this._inBlock[i] = this._prev[i] ^ input.getInt32();
    }
    this.cipher.encrypt(this._inBlock, this._outBlock);
    for (var i = 0; i < this._ints; ++i) {
      output.putInt32(this._outBlock[i]);
    }
    this._prev = this._outBlock;
  };
  modes.cbc.prototype.decrypt = function(input, output, finish) {
    if (input.length() < this.blockSize && !(finish && input.length() > 0)) {
      return true;
    }
    for (var i = 0; i < this._ints; ++i) {
      this._inBlock[i] = input.getInt32();
    }
    this.cipher.decrypt(this._inBlock, this._outBlock);
    for (var i = 0; i < this._ints; ++i) {
      output.putInt32(this._prev[i] ^ this._outBlock[i]);
    }
    this._prev = this._inBlock.slice(0);
  };
  modes.cbc.prototype.pad = function(input, options) {
    var padding = input.length() === this.blockSize ? this.blockSize : this.blockSize - input.length();
    input.fillWithByte(padding, padding);
    return true;
  };
  modes.cbc.prototype.unpad = function(output, options) {
    if (options.overflow > 0) {
      return false;
    }
    var len = output.length();
    var count = output.at(len - 1);
    if (count > this.blockSize << 2) {
      return false;
    }
    output.truncate(count);
    return true;
  };
  modes.cfb = function(options) {
    options = options || {};
    this.name = "CFB";
    this.cipher = options.cipher;
    this.blockSize = options.blockSize || 16;
    this._ints = this.blockSize / 4;
    this._inBlock = null;
    this._outBlock = new Array(this._ints);
    this._partialBlock = new Array(this._ints);
    this._partialOutput = forge2.util.createBuffer();
    this._partialBytes = 0;
  };
  modes.cfb.prototype.start = function(options) {
    if (!("iv" in options)) {
      throw new Error("Invalid IV parameter.");
    }
    this._iv = transformIV(options.iv, this.blockSize);
    this._inBlock = this._iv.slice(0);
    this._partialBytes = 0;
  };
  modes.cfb.prototype.encrypt = function(input, output, finish) {
    var inputLength = input.length();
    if (inputLength === 0) {
      return true;
    }
    this.cipher.encrypt(this._inBlock, this._outBlock);
    if (this._partialBytes === 0 && inputLength >= this.blockSize) {
      for (var i = 0; i < this._ints; ++i) {
        this._inBlock[i] = input.getInt32() ^ this._outBlock[i];
        output.putInt32(this._inBlock[i]);
      }
      return;
    }
    var partialBytes = (this.blockSize - inputLength) % this.blockSize;
    if (partialBytes > 0) {
      partialBytes = this.blockSize - partialBytes;
    }
    this._partialOutput.clear();
    for (var i = 0; i < this._ints; ++i) {
      this._partialBlock[i] = input.getInt32() ^ this._outBlock[i];
      this._partialOutput.putInt32(this._partialBlock[i]);
    }
    if (partialBytes > 0) {
      input.read -= this.blockSize;
    } else {
      for (var i = 0; i < this._ints; ++i) {
        this._inBlock[i] = this._partialBlock[i];
      }
    }
    if (this._partialBytes > 0) {
      this._partialOutput.getBytes(this._partialBytes);
    }
    if (partialBytes > 0 && !finish) {
      output.putBytes(this._partialOutput.getBytes(
        partialBytes - this._partialBytes
      ));
      this._partialBytes = partialBytes;
      return true;
    }
    output.putBytes(this._partialOutput.getBytes(
      inputLength - this._partialBytes
    ));
    this._partialBytes = 0;
  };
  modes.cfb.prototype.decrypt = function(input, output, finish) {
    var inputLength = input.length();
    if (inputLength === 0) {
      return true;
    }
    this.cipher.encrypt(this._inBlock, this._outBlock);
    if (this._partialBytes === 0 && inputLength >= this.blockSize) {
      for (var i = 0; i < this._ints; ++i) {
        this._inBlock[i] = input.getInt32();
        output.putInt32(this._inBlock[i] ^ this._outBlock[i]);
      }
      return;
    }
    var partialBytes = (this.blockSize - inputLength) % this.blockSize;
    if (partialBytes > 0) {
      partialBytes = this.blockSize - partialBytes;
    }
    this._partialOutput.clear();
    for (var i = 0; i < this._ints; ++i) {
      this._partialBlock[i] = input.getInt32();
      this._partialOutput.putInt32(this._partialBlock[i] ^ this._outBlock[i]);
    }
    if (partialBytes > 0) {
      input.read -= this.blockSize;
    } else {
      for (var i = 0; i < this._ints; ++i) {
        this._inBlock[i] = this._partialBlock[i];
      }
    }
    if (this._partialBytes > 0) {
      this._partialOutput.getBytes(this._partialBytes);
    }
    if (partialBytes > 0 && !finish) {
      output.putBytes(this._partialOutput.getBytes(
        partialBytes - this._partialBytes
      ));
      this._partialBytes = partialBytes;
      return true;
    }
    output.putBytes(this._partialOutput.getBytes(
      inputLength - this._partialBytes
    ));
    this._partialBytes = 0;
  };
  modes.ofb = function(options) {
    options = options || {};
    this.name = "OFB";
    this.cipher = options.cipher;
    this.blockSize = options.blockSize || 16;
    this._ints = this.blockSize / 4;
    this._inBlock = null;
    this._outBlock = new Array(this._ints);
    this._partialOutput = forge2.util.createBuffer();
    this._partialBytes = 0;
  };
  modes.ofb.prototype.start = function(options) {
    if (!("iv" in options)) {
      throw new Error("Invalid IV parameter.");
    }
    this._iv = transformIV(options.iv, this.blockSize);
    this._inBlock = this._iv.slice(0);
    this._partialBytes = 0;
  };
  modes.ofb.prototype.encrypt = function(input, output, finish) {
    var inputLength = input.length();
    if (input.length() === 0) {
      return true;
    }
    this.cipher.encrypt(this._inBlock, this._outBlock);
    if (this._partialBytes === 0 && inputLength >= this.blockSize) {
      for (var i = 0; i < this._ints; ++i) {
        output.putInt32(input.getInt32() ^ this._outBlock[i]);
        this._inBlock[i] = this._outBlock[i];
      }
      return;
    }
    var partialBytes = (this.blockSize - inputLength) % this.blockSize;
    if (partialBytes > 0) {
      partialBytes = this.blockSize - partialBytes;
    }
    this._partialOutput.clear();
    for (var i = 0; i < this._ints; ++i) {
      this._partialOutput.putInt32(input.getInt32() ^ this._outBlock[i]);
    }
    if (partialBytes > 0) {
      input.read -= this.blockSize;
    } else {
      for (var i = 0; i < this._ints; ++i) {
        this._inBlock[i] = this._outBlock[i];
      }
    }
    if (this._partialBytes > 0) {
      this._partialOutput.getBytes(this._partialBytes);
    }
    if (partialBytes > 0 && !finish) {
      output.putBytes(this._partialOutput.getBytes(
        partialBytes - this._partialBytes
      ));
      this._partialBytes = partialBytes;
      return true;
    }
    output.putBytes(this._partialOutput.getBytes(
      inputLength - this._partialBytes
    ));
    this._partialBytes = 0;
  };
  modes.ofb.prototype.decrypt = modes.ofb.prototype.encrypt;
  modes.ctr = function(options) {
    options = options || {};
    this.name = "CTR";
    this.cipher = options.cipher;
    this.blockSize = options.blockSize || 16;
    this._ints = this.blockSize / 4;
    this._inBlock = null;
    this._outBlock = new Array(this._ints);
    this._partialOutput = forge2.util.createBuffer();
    this._partialBytes = 0;
  };
  modes.ctr.prototype.start = function(options) {
    if (!("iv" in options)) {
      throw new Error("Invalid IV parameter.");
    }
    this._iv = transformIV(options.iv, this.blockSize);
    this._inBlock = this._iv.slice(0);
    this._partialBytes = 0;
  };
  modes.ctr.prototype.encrypt = function(input, output, finish) {
    var inputLength = input.length();
    if (inputLength === 0) {
      return true;
    }
    this.cipher.encrypt(this._inBlock, this._outBlock);
    if (this._partialBytes === 0 && inputLength >= this.blockSize) {
      for (var i = 0; i < this._ints; ++i) {
        output.putInt32(input.getInt32() ^ this._outBlock[i]);
      }
    } else {
      var partialBytes = (this.blockSize - inputLength) % this.blockSize;
      if (partialBytes > 0) {
        partialBytes = this.blockSize - partialBytes;
      }
      this._partialOutput.clear();
      for (var i = 0; i < this._ints; ++i) {
        this._partialOutput.putInt32(input.getInt32() ^ this._outBlock[i]);
      }
      if (partialBytes > 0) {
        input.read -= this.blockSize;
      }
      if (this._partialBytes > 0) {
        this._partialOutput.getBytes(this._partialBytes);
      }
      if (partialBytes > 0 && !finish) {
        output.putBytes(this._partialOutput.getBytes(
          partialBytes - this._partialBytes
        ));
        this._partialBytes = partialBytes;
        return true;
      }
      output.putBytes(this._partialOutput.getBytes(
        inputLength - this._partialBytes
      ));
      this._partialBytes = 0;
    }
    inc32(this._inBlock);
  };
  modes.ctr.prototype.decrypt = modes.ctr.prototype.encrypt;
  modes.gcm = function(options) {
    options = options || {};
    this.name = "GCM";
    this.cipher = options.cipher;
    this.blockSize = options.blockSize || 16;
    this._ints = this.blockSize / 4;
    this._inBlock = new Array(this._ints);
    this._outBlock = new Array(this._ints);
    this._partialOutput = forge2.util.createBuffer();
    this._partialBytes = 0;
    this._R = 3774873600;
  };
  modes.gcm.prototype.start = function(options) {
    if (!("iv" in options)) {
      throw new Error("Invalid IV parameter.");
    }
    var iv = forge2.util.createBuffer(options.iv);
    this._cipherLength = 0;
    var additionalData;
    if ("additionalData" in options) {
      additionalData = forge2.util.createBuffer(options.additionalData);
    } else {
      additionalData = forge2.util.createBuffer();
    }
    if ("tagLength" in options) {
      this._tagLength = options.tagLength;
    } else {
      this._tagLength = 128;
    }
    this._tag = null;
    if (options.decrypt) {
      this._tag = forge2.util.createBuffer(options.tag).getBytes();
      if (this._tag.length !== this._tagLength / 8) {
        throw new Error("Authentication tag does not match tag length.");
      }
    }
    this._hashBlock = new Array(this._ints);
    this.tag = null;
    this._hashSubkey = new Array(this._ints);
    this.cipher.encrypt([0, 0, 0, 0], this._hashSubkey);
    this.componentBits = 4;
    this._m = this.generateHashTable(this._hashSubkey, this.componentBits);
    var ivLength = iv.length();
    if (ivLength === 12) {
      this._j0 = [iv.getInt32(), iv.getInt32(), iv.getInt32(), 1];
    } else {
      this._j0 = [0, 0, 0, 0];
      while (iv.length() > 0) {
        this._j0 = this.ghash(
          this._hashSubkey,
          this._j0,
          [iv.getInt32(), iv.getInt32(), iv.getInt32(), iv.getInt32()]
        );
      }
      this._j0 = this.ghash(
        this._hashSubkey,
        this._j0,
        [0, 0].concat(from64To32(ivLength * 8))
      );
    }
    this._inBlock = this._j0.slice(0);
    inc32(this._inBlock);
    this._partialBytes = 0;
    additionalData = forge2.util.createBuffer(additionalData);
    this._aDataLength = from64To32(additionalData.length() * 8);
    var overflow = additionalData.length() % this.blockSize;
    if (overflow) {
      additionalData.fillWithByte(0, this.blockSize - overflow);
    }
    this._s = [0, 0, 0, 0];
    while (additionalData.length() > 0) {
      this._s = this.ghash(this._hashSubkey, this._s, [
        additionalData.getInt32(),
        additionalData.getInt32(),
        additionalData.getInt32(),
        additionalData.getInt32()
      ]);
    }
  };
  modes.gcm.prototype.encrypt = function(input, output, finish) {
    var inputLength = input.length();
    if (inputLength === 0) {
      return true;
    }
    this.cipher.encrypt(this._inBlock, this._outBlock);
    if (this._partialBytes === 0 && inputLength >= this.blockSize) {
      for (var i = 0; i < this._ints; ++i) {
        output.putInt32(this._outBlock[i] ^= input.getInt32());
      }
      this._cipherLength += this.blockSize;
    } else {
      var partialBytes = (this.blockSize - inputLength) % this.blockSize;
      if (partialBytes > 0) {
        partialBytes = this.blockSize - partialBytes;
      }
      this._partialOutput.clear();
      for (var i = 0; i < this._ints; ++i) {
        this._partialOutput.putInt32(input.getInt32() ^ this._outBlock[i]);
      }
      if (partialBytes <= 0 || finish) {
        if (finish) {
          var overflow = inputLength % this.blockSize;
          this._cipherLength += overflow;
          this._partialOutput.truncate(this.blockSize - overflow);
        } else {
          this._cipherLength += this.blockSize;
        }
        for (var i = 0; i < this._ints; ++i) {
          this._outBlock[i] = this._partialOutput.getInt32();
        }
        this._partialOutput.read -= this.blockSize;
      }
      if (this._partialBytes > 0) {
        this._partialOutput.getBytes(this._partialBytes);
      }
      if (partialBytes > 0 && !finish) {
        input.read -= this.blockSize;
        output.putBytes(this._partialOutput.getBytes(
          partialBytes - this._partialBytes
        ));
        this._partialBytes = partialBytes;
        return true;
      }
      output.putBytes(this._partialOutput.getBytes(
        inputLength - this._partialBytes
      ));
      this._partialBytes = 0;
    }
    this._s = this.ghash(this._hashSubkey, this._s, this._outBlock);
    inc32(this._inBlock);
  };
  modes.gcm.prototype.decrypt = function(input, output, finish) {
    var inputLength = input.length();
    if (inputLength < this.blockSize && !(finish && inputLength > 0)) {
      return true;
    }
    this.cipher.encrypt(this._inBlock, this._outBlock);
    inc32(this._inBlock);
    this._hashBlock[0] = input.getInt32();
    this._hashBlock[1] = input.getInt32();
    this._hashBlock[2] = input.getInt32();
    this._hashBlock[3] = input.getInt32();
    this._s = this.ghash(this._hashSubkey, this._s, this._hashBlock);
    for (var i = 0; i < this._ints; ++i) {
      output.putInt32(this._outBlock[i] ^ this._hashBlock[i]);
    }
    if (inputLength < this.blockSize) {
      this._cipherLength += inputLength % this.blockSize;
    } else {
      this._cipherLength += this.blockSize;
    }
  };
  modes.gcm.prototype.afterFinish = function(output, options) {
    var rval = true;
    if (options.decrypt && options.overflow) {
      output.truncate(this.blockSize - options.overflow);
    }
    this.tag = forge2.util.createBuffer();
    var lengths = this._aDataLength.concat(from64To32(this._cipherLength * 8));
    this._s = this.ghash(this._hashSubkey, this._s, lengths);
    var tag = [];
    this.cipher.encrypt(this._j0, tag);
    for (var i = 0; i < this._ints; ++i) {
      this.tag.putInt32(this._s[i] ^ tag[i]);
    }
    this.tag.truncate(this.tag.length() % (this._tagLength / 8));
    if (options.decrypt && this.tag.bytes() !== this._tag) {
      rval = false;
    }
    return rval;
  };
  modes.gcm.prototype.multiply = function(x, y) {
    var z_i = [0, 0, 0, 0];
    var v_i = y.slice(0);
    for (var i = 0; i < 128; ++i) {
      var x_i = x[i / 32 | 0] & 1 << 31 - i % 32;
      if (x_i) {
        z_i[0] ^= v_i[0];
        z_i[1] ^= v_i[1];
        z_i[2] ^= v_i[2];
        z_i[3] ^= v_i[3];
      }
      this.pow(v_i, v_i);
    }
    return z_i;
  };
  modes.gcm.prototype.pow = function(x, out) {
    var lsb = x[3] & 1;
    for (var i = 3; i > 0; --i) {
      out[i] = x[i] >>> 1 | (x[i - 1] & 1) << 31;
    }
    out[0] = x[0] >>> 1;
    if (lsb) {
      out[0] ^= this._R;
    }
  };
  modes.gcm.prototype.tableMultiply = function(x) {
    var z = [0, 0, 0, 0];
    for (var i = 0; i < 32; ++i) {
      var idx = i / 8 | 0;
      var x_i = x[idx] >>> (7 - i % 8) * 4 & 15;
      var ah = this._m[i][x_i];
      z[0] ^= ah[0];
      z[1] ^= ah[1];
      z[2] ^= ah[2];
      z[3] ^= ah[3];
    }
    return z;
  };
  modes.gcm.prototype.ghash = function(h, y, x) {
    y[0] ^= x[0];
    y[1] ^= x[1];
    y[2] ^= x[2];
    y[3] ^= x[3];
    return this.tableMultiply(y);
  };
  modes.gcm.prototype.generateHashTable = function(h, bits) {
    var multiplier = 8 / bits;
    var perInt = 4 * multiplier;
    var size = 16 * multiplier;
    var m = new Array(size);
    for (var i = 0; i < size; ++i) {
      var tmp = [0, 0, 0, 0];
      var idx = i / perInt | 0;
      var shft = (perInt - 1 - i % perInt) * bits;
      tmp[idx] = 1 << bits - 1 << shft;
      m[i] = this.generateSubHashTable(this.multiply(tmp, h), bits);
    }
    return m;
  };
  modes.gcm.prototype.generateSubHashTable = function(mid, bits) {
    var size = 1 << bits;
    var half = size >>> 1;
    var m = new Array(size);
    m[half] = mid.slice(0);
    var i = half >>> 1;
    while (i > 0) {
      this.pow(m[2 * i], m[i] = []);
      i >>= 1;
    }
    i = 2;
    while (i < half) {
      for (var j = 1; j < i; ++j) {
        var m_i = m[i];
        var m_j = m[j];
        m[i + j] = [
          m_i[0] ^ m_j[0],
          m_i[1] ^ m_j[1],
          m_i[2] ^ m_j[2],
          m_i[3] ^ m_j[3]
        ];
      }
      i *= 2;
    }
    m[0] = [0, 0, 0, 0];
    for (i = half + 1; i < size; ++i) {
      var c = m[i ^ half];
      m[i] = [mid[0] ^ c[0], mid[1] ^ c[1], mid[2] ^ c[2], mid[3] ^ c[3]];
    }
    return m;
  };
  function transformIV(iv, blockSize) {
    if (typeof iv === "string") {
      iv = forge2.util.createBuffer(iv);
    }
    if (forge2.util.isArray(iv) && iv.length > 4) {
      var tmp = iv;
      iv = forge2.util.createBuffer();
      for (var i = 0; i < tmp.length; ++i) {
        iv.putByte(tmp[i]);
      }
    }
    if (iv.length() < blockSize) {
      throw new Error(
        "Invalid IV length; got " + iv.length() + " bytes and expected " + blockSize + " bytes."
      );
    }
    if (!forge2.util.isArray(iv)) {
      var ints = [];
      var blocks = blockSize / 4;
      for (var i = 0; i < blocks; ++i) {
        ints.push(iv.getInt32());
      }
      iv = ints;
    }
    return iv;
  }
  function inc32(block) {
    block[block.length - 1] = block[block.length - 1] + 1 & 4294967295;
  }
  function from64To32(num) {
    return [num / 4294967296 | 0, num & 4294967295];
  }
  return cipherModes.exports;
}
var aes;
var hasRequiredAes;
function requireAes() {
  if (hasRequiredAes) return aes;
  hasRequiredAes = 1;
  var forge2 = requireForge();
  requireCipher();
  requireCipherModes();
  requireUtil();
  aes = forge2.aes = forge2.aes || {};
  forge2.aes.startEncrypting = function(key, iv, output, mode) {
    var cipher2 = _createCipher({
      key,
      output,
      decrypt: false,
      mode
    });
    cipher2.start(iv);
    return cipher2;
  };
  forge2.aes.createEncryptionCipher = function(key, mode) {
    return _createCipher({
      key,
      output: null,
      decrypt: false,
      mode
    });
  };
  forge2.aes.startDecrypting = function(key, iv, output, mode) {
    var cipher2 = _createCipher({
      key,
      output,
      decrypt: true,
      mode
    });
    cipher2.start(iv);
    return cipher2;
  };
  forge2.aes.createDecryptionCipher = function(key, mode) {
    return _createCipher({
      key,
      output: null,
      decrypt: true,
      mode
    });
  };
  forge2.aes.Algorithm = function(name, mode) {
    if (!init) {
      initialize();
    }
    var self2 = this;
    self2.name = name;
    self2.mode = new mode({
      blockSize: 16,
      cipher: {
        encrypt: function(inBlock, outBlock) {
          return _updateBlock(self2._w, inBlock, outBlock, false);
        },
        decrypt: function(inBlock, outBlock) {
          return _updateBlock(self2._w, inBlock, outBlock, true);
        }
      }
    });
    self2._init = false;
  };
  forge2.aes.Algorithm.prototype.initialize = function(options) {
    if (this._init) {
      return;
    }
    var key = options.key;
    var tmp;
    if (typeof key === "string" && (key.length === 16 || key.length === 24 || key.length === 32)) {
      key = forge2.util.createBuffer(key);
    } else if (forge2.util.isArray(key) && (key.length === 16 || key.length === 24 || key.length === 32)) {
      tmp = key;
      key = forge2.util.createBuffer();
      for (var i = 0; i < tmp.length; ++i) {
        key.putByte(tmp[i]);
      }
    }
    if (!forge2.util.isArray(key)) {
      tmp = key;
      key = [];
      var len = tmp.length();
      if (len === 16 || len === 24 || len === 32) {
        len = len >>> 2;
        for (var i = 0; i < len; ++i) {
          key.push(tmp.getInt32());
        }
      }
    }
    if (!forge2.util.isArray(key) || !(key.length === 4 || key.length === 6 || key.length === 8)) {
      throw new Error("Invalid key parameter.");
    }
    var mode = this.mode.name;
    var encryptOp = ["CFB", "OFB", "CTR", "GCM"].indexOf(mode) !== -1;
    this._w = _expandKey(key, options.decrypt && !encryptOp);
    this._init = true;
  };
  forge2.aes._expandKey = function(key, decrypt) {
    if (!init) {
      initialize();
    }
    return _expandKey(key, decrypt);
  };
  forge2.aes._updateBlock = _updateBlock;
  registerAlgorithm("AES-ECB", forge2.cipher.modes.ecb);
  registerAlgorithm("AES-CBC", forge2.cipher.modes.cbc);
  registerAlgorithm("AES-CFB", forge2.cipher.modes.cfb);
  registerAlgorithm("AES-OFB", forge2.cipher.modes.ofb);
  registerAlgorithm("AES-CTR", forge2.cipher.modes.ctr);
  registerAlgorithm("AES-GCM", forge2.cipher.modes.gcm);
  function registerAlgorithm(name, mode) {
    var factory = function() {
      return new forge2.aes.Algorithm(name, mode);
    };
    forge2.cipher.registerAlgorithm(name, factory);
  }
  var init = false;
  var Nb = 4;
  var sbox;
  var isbox;
  var rcon;
  var mix;
  var imix;
  function initialize() {
    init = true;
    rcon = [0, 1, 2, 4, 8, 16, 32, 64, 128, 27, 54];
    var xtime = new Array(256);
    for (var i = 0; i < 128; ++i) {
      xtime[i] = i << 1;
      xtime[i + 128] = i + 128 << 1 ^ 283;
    }
    sbox = new Array(256);
    isbox = new Array(256);
    mix = new Array(4);
    imix = new Array(4);
    for (var i = 0; i < 4; ++i) {
      mix[i] = new Array(256);
      imix[i] = new Array(256);
    }
    var e = 0, ei = 0, e2, e4, e8, sx, sx2, me, ime;
    for (var i = 0; i < 256; ++i) {
      sx = ei ^ ei << 1 ^ ei << 2 ^ ei << 3 ^ ei << 4;
      sx = sx >> 8 ^ sx & 255 ^ 99;
      sbox[e] = sx;
      isbox[sx] = e;
      sx2 = xtime[sx];
      e2 = xtime[e];
      e4 = xtime[e2];
      e8 = xtime[e4];
      me = sx2 << 24 ^ // 2
      sx << 16 ^ // 1
      sx << 8 ^ // 1
      (sx ^ sx2);
      ime = (e2 ^ e4 ^ e8) << 24 ^ // E (14)
      (e ^ e8) << 16 ^ // 9
      (e ^ e4 ^ e8) << 8 ^ // D (13)
      (e ^ e2 ^ e8);
      for (var n = 0; n < 4; ++n) {
        mix[n][e] = me;
        imix[n][sx] = ime;
        me = me << 24 | me >>> 8;
        ime = ime << 24 | ime >>> 8;
      }
      if (e === 0) {
        e = ei = 1;
      } else {
        e = e2 ^ xtime[xtime[xtime[e2 ^ e8]]];
        ei ^= xtime[xtime[ei]];
      }
    }
  }
  function _expandKey(key, decrypt) {
    var w = key.slice(0);
    var temp, iNk = 1;
    var Nk = w.length;
    var Nr1 = Nk + 6 + 1;
    var end = Nb * Nr1;
    for (var i = Nk; i < end; ++i) {
      temp = w[i - 1];
      if (i % Nk === 0) {
        temp = sbox[temp >>> 16 & 255] << 24 ^ sbox[temp >>> 8 & 255] << 16 ^ sbox[temp & 255] << 8 ^ sbox[temp >>> 24] ^ rcon[iNk] << 24;
        iNk++;
      } else if (Nk > 6 && i % Nk === 4) {
        temp = sbox[temp >>> 24] << 24 ^ sbox[temp >>> 16 & 255] << 16 ^ sbox[temp >>> 8 & 255] << 8 ^ sbox[temp & 255];
      }
      w[i] = w[i - Nk] ^ temp;
    }
    if (decrypt) {
      var tmp;
      var m0 = imix[0];
      var m1 = imix[1];
      var m2 = imix[2];
      var m3 = imix[3];
      var wnew = w.slice(0);
      end = w.length;
      for (var i = 0, wi = end - Nb; i < end; i += Nb, wi -= Nb) {
        if (i === 0 || i === end - Nb) {
          wnew[i] = w[wi];
          wnew[i + 1] = w[wi + 3];
          wnew[i + 2] = w[wi + 2];
          wnew[i + 3] = w[wi + 1];
        } else {
          for (var n = 0; n < Nb; ++n) {
            tmp = w[wi + n];
            wnew[i + (3 & -n)] = m0[sbox[tmp >>> 24]] ^ m1[sbox[tmp >>> 16 & 255]] ^ m2[sbox[tmp >>> 8 & 255]] ^ m3[sbox[tmp & 255]];
          }
        }
      }
      w = wnew;
    }
    return w;
  }
  function _updateBlock(w, input, output, decrypt) {
    var Nr = w.length / 4 - 1;
    var m0, m1, m2, m3, sub;
    if (decrypt) {
      m0 = imix[0];
      m1 = imix[1];
      m2 = imix[2];
      m3 = imix[3];
      sub = isbox;
    } else {
      m0 = mix[0];
      m1 = mix[1];
      m2 = mix[2];
      m3 = mix[3];
      sub = sbox;
    }
    var a, b, c, d, a2, b2, c2;
    a = input[0] ^ w[0];
    b = input[decrypt ? 3 : 1] ^ w[1];
    c = input[2] ^ w[2];
    d = input[decrypt ? 1 : 3] ^ w[3];
    var i = 3;
    for (var round = 1; round < Nr; ++round) {
      a2 = m0[a >>> 24] ^ m1[b >>> 16 & 255] ^ m2[c >>> 8 & 255] ^ m3[d & 255] ^ w[++i];
      b2 = m0[b >>> 24] ^ m1[c >>> 16 & 255] ^ m2[d >>> 8 & 255] ^ m3[a & 255] ^ w[++i];
      c2 = m0[c >>> 24] ^ m1[d >>> 16 & 255] ^ m2[a >>> 8 & 255] ^ m3[b & 255] ^ w[++i];
      d = m0[d >>> 24] ^ m1[a >>> 16 & 255] ^ m2[b >>> 8 & 255] ^ m3[c & 255] ^ w[++i];
      a = a2;
      b = b2;
      c = c2;
    }
    output[0] = sub[a >>> 24] << 24 ^ sub[b >>> 16 & 255] << 16 ^ sub[c >>> 8 & 255] << 8 ^ sub[d & 255] ^ w[++i];
    output[decrypt ? 3 : 1] = sub[b >>> 24] << 24 ^ sub[c >>> 16 & 255] << 16 ^ sub[d >>> 8 & 255] << 8 ^ sub[a & 255] ^ w[++i];
    output[2] = sub[c >>> 24] << 24 ^ sub[d >>> 16 & 255] << 16 ^ sub[a >>> 8 & 255] << 8 ^ sub[b & 255] ^ w[++i];
    output[decrypt ? 1 : 3] = sub[d >>> 24] << 24 ^ sub[a >>> 16 & 255] << 16 ^ sub[b >>> 8 & 255] << 8 ^ sub[c & 255] ^ w[++i];
  }
  function _createCipher(options) {
    options = options || {};
    var mode = (options.mode || "CBC").toUpperCase();
    var algorithm = "AES-" + mode;
    var cipher2;
    if (options.decrypt) {
      cipher2 = forge2.cipher.createDecipher(algorithm, options.key);
    } else {
      cipher2 = forge2.cipher.createCipher(algorithm, options.key);
    }
    var start = cipher2.start;
    cipher2.start = function(iv, options2) {
      var output = null;
      if (options2 instanceof forge2.util.ByteBuffer) {
        output = options2;
        options2 = {};
      }
      options2 = options2 || {};
      options2.output = output;
      options2.iv = iv;
      start.call(cipher2, options2);
    };
    return cipher2;
  }
  return aes;
}
var aesCipherSuites = { exports: {} };
var asn1 = { exports: {} };
var oids = { exports: {} };
var hasRequiredOids;
function requireOids() {
  if (hasRequiredOids) return oids.exports;
  hasRequiredOids = 1;
  var forge2 = requireForge();
  forge2.pki = forge2.pki || {};
  var oids$1 = oids.exports = forge2.pki.oids = forge2.oids = forge2.oids || {};
  function _IN(id, name) {
    oids$1[id] = name;
    oids$1[name] = id;
  }
  function _I_(id, name) {
    oids$1[id] = name;
  }
  _IN("1.2.840.113549.1.1.1", "rsaEncryption");
  _IN("1.2.840.113549.1.1.4", "md5WithRSAEncryption");
  _IN("1.2.840.113549.1.1.5", "sha1WithRSAEncryption");
  _IN("1.2.840.113549.1.1.7", "RSAES-OAEP");
  _IN("1.2.840.113549.1.1.8", "mgf1");
  _IN("1.2.840.113549.1.1.9", "pSpecified");
  _IN("1.2.840.113549.1.1.10", "RSASSA-PSS");
  _IN("1.2.840.113549.1.1.11", "sha256WithRSAEncryption");
  _IN("1.2.840.113549.1.1.12", "sha384WithRSAEncryption");
  _IN("1.2.840.113549.1.1.13", "sha512WithRSAEncryption");
  _IN("1.3.101.112", "EdDSA25519");
  _IN("1.2.840.10040.4.3", "dsa-with-sha1");
  _IN("1.3.14.3.2.7", "desCBC");
  _IN("1.3.14.3.2.26", "sha1");
  _IN("1.3.14.3.2.29", "sha1WithRSASignature");
  _IN("2.16.840.1.101.3.4.2.1", "sha256");
  _IN("2.16.840.1.101.3.4.2.2", "sha384");
  _IN("2.16.840.1.101.3.4.2.3", "sha512");
  _IN("2.16.840.1.101.3.4.2.4", "sha224");
  _IN("2.16.840.1.101.3.4.2.5", "sha512-224");
  _IN("2.16.840.1.101.3.4.2.6", "sha512-256");
  _IN("1.2.840.113549.2.2", "md2");
  _IN("1.2.840.113549.2.5", "md5");
  _IN("1.2.840.113549.1.7.1", "data");
  _IN("1.2.840.113549.1.7.2", "signedData");
  _IN("1.2.840.113549.1.7.3", "envelopedData");
  _IN("1.2.840.113549.1.7.4", "signedAndEnvelopedData");
  _IN("1.2.840.113549.1.7.5", "digestedData");
  _IN("1.2.840.113549.1.7.6", "encryptedData");
  _IN("1.2.840.113549.1.9.1", "emailAddress");
  _IN("1.2.840.113549.1.9.2", "unstructuredName");
  _IN("1.2.840.113549.1.9.3", "contentType");
  _IN("1.2.840.113549.1.9.4", "messageDigest");
  _IN("1.2.840.113549.1.9.5", "signingTime");
  _IN("1.2.840.113549.1.9.6", "counterSignature");
  _IN("1.2.840.113549.1.9.7", "challengePassword");
  _IN("1.2.840.113549.1.9.8", "unstructuredAddress");
  _IN("1.2.840.113549.1.9.14", "extensionRequest");
  _IN("1.2.840.113549.1.9.20", "friendlyName");
  _IN("1.2.840.113549.1.9.21", "localKeyId");
  _IN("1.2.840.113549.1.9.22.1", "x509Certificate");
  _IN("1.2.840.113549.1.12.10.1.1", "keyBag");
  _IN("1.2.840.113549.1.12.10.1.2", "pkcs8ShroudedKeyBag");
  _IN("1.2.840.113549.1.12.10.1.3", "certBag");
  _IN("1.2.840.113549.1.12.10.1.4", "crlBag");
  _IN("1.2.840.113549.1.12.10.1.5", "secretBag");
  _IN("1.2.840.113549.1.12.10.1.6", "safeContentsBag");
  _IN("1.2.840.113549.1.5.13", "pkcs5PBES2");
  _IN("1.2.840.113549.1.5.12", "pkcs5PBKDF2");
  _IN("1.2.840.113549.1.12.1.1", "pbeWithSHAAnd128BitRC4");
  _IN("1.2.840.113549.1.12.1.2", "pbeWithSHAAnd40BitRC4");
  _IN("1.2.840.113549.1.12.1.3", "pbeWithSHAAnd3-KeyTripleDES-CBC");
  _IN("1.2.840.113549.1.12.1.4", "pbeWithSHAAnd2-KeyTripleDES-CBC");
  _IN("1.2.840.113549.1.12.1.5", "pbeWithSHAAnd128BitRC2-CBC");
  _IN("1.2.840.113549.1.12.1.6", "pbewithSHAAnd40BitRC2-CBC");
  _IN("1.2.840.113549.2.7", "hmacWithSHA1");
  _IN("1.2.840.113549.2.8", "hmacWithSHA224");
  _IN("1.2.840.113549.2.9", "hmacWithSHA256");
  _IN("1.2.840.113549.2.10", "hmacWithSHA384");
  _IN("1.2.840.113549.2.11", "hmacWithSHA512");
  _IN("1.2.840.113549.3.7", "des-EDE3-CBC");
  _IN("2.16.840.1.101.3.4.1.2", "aes128-CBC");
  _IN("2.16.840.1.101.3.4.1.22", "aes192-CBC");
  _IN("2.16.840.1.101.3.4.1.42", "aes256-CBC");
  _IN("2.5.4.3", "commonName");
  _IN("2.5.4.4", "surname");
  _IN("2.5.4.5", "serialNumber");
  _IN("2.5.4.6", "countryName");
  _IN("2.5.4.7", "localityName");
  _IN("2.5.4.8", "stateOrProvinceName");
  _IN("2.5.4.9", "streetAddress");
  _IN("2.5.4.10", "organizationName");
  _IN("2.5.4.11", "organizationalUnitName");
  _IN("2.5.4.12", "title");
  _IN("2.5.4.13", "description");
  _IN("2.5.4.15", "businessCategory");
  _IN("2.5.4.17", "postalCode");
  _IN("2.5.4.42", "givenName");
  _IN("2.5.4.65", "pseudonym");
  _IN("1.3.6.1.4.1.311.60.2.1.2", "jurisdictionOfIncorporationStateOrProvinceName");
  _IN("1.3.6.1.4.1.311.60.2.1.3", "jurisdictionOfIncorporationCountryName");
  _IN("2.16.840.1.113730.1.1", "nsCertType");
  _IN("2.16.840.1.113730.1.13", "nsComment");
  _I_("2.5.29.1", "authorityKeyIdentifier");
  _I_("2.5.29.2", "keyAttributes");
  _I_("2.5.29.3", "certificatePolicies");
  _I_("2.5.29.4", "keyUsageRestriction");
  _I_("2.5.29.5", "policyMapping");
  _I_("2.5.29.6", "subtreesConstraint");
  _I_("2.5.29.7", "subjectAltName");
  _I_("2.5.29.8", "issuerAltName");
  _I_("2.5.29.9", "subjectDirectoryAttributes");
  _I_("2.5.29.10", "basicConstraints");
  _I_("2.5.29.11", "nameConstraints");
  _I_("2.5.29.12", "policyConstraints");
  _I_("2.5.29.13", "basicConstraints");
  _IN("2.5.29.14", "subjectKeyIdentifier");
  _IN("2.5.29.15", "keyUsage");
  _I_("2.5.29.16", "privateKeyUsagePeriod");
  _IN("2.5.29.17", "subjectAltName");
  _IN("2.5.29.18", "issuerAltName");
  _IN("2.5.29.19", "basicConstraints");
  _I_("2.5.29.20", "cRLNumber");
  _I_("2.5.29.21", "cRLReason");
  _I_("2.5.29.22", "expirationDate");
  _I_("2.5.29.23", "instructionCode");
  _I_("2.5.29.24", "invalidityDate");
  _I_("2.5.29.25", "cRLDistributionPoints");
  _I_("2.5.29.26", "issuingDistributionPoint");
  _I_("2.5.29.27", "deltaCRLIndicator");
  _I_("2.5.29.28", "issuingDistributionPoint");
  _I_("2.5.29.29", "certificateIssuer");
  _I_("2.5.29.30", "nameConstraints");
  _IN("2.5.29.31", "cRLDistributionPoints");
  _IN("2.5.29.32", "certificatePolicies");
  _I_("2.5.29.33", "policyMappings");
  _I_("2.5.29.34", "policyConstraints");
  _IN("2.5.29.35", "authorityKeyIdentifier");
  _I_("2.5.29.36", "policyConstraints");
  _IN("2.5.29.37", "extKeyUsage");
  _I_("2.5.29.46", "freshestCRL");
  _I_("2.5.29.54", "inhibitAnyPolicy");
  _IN("1.3.6.1.4.1.11129.2.4.2", "timestampList");
  _IN("1.3.6.1.5.5.7.1.1", "authorityInfoAccess");
  _IN("1.3.6.1.5.5.7.3.1", "serverAuth");
  _IN("1.3.6.1.5.5.7.3.2", "clientAuth");
  _IN("1.3.6.1.5.5.7.3.3", "codeSigning");
  _IN("1.3.6.1.5.5.7.3.4", "emailProtection");
  _IN("1.3.6.1.5.5.7.3.8", "timeStamping");
  return oids.exports;
}
var hasRequiredAsn1;
function requireAsn1() {
  if (hasRequiredAsn1) return asn1.exports;
  hasRequiredAsn1 = 1;
  var forge2 = requireForge();
  requireUtil();
  requireOids();
  var asn1$1 = asn1.exports = forge2.asn1 = forge2.asn1 || {};
  asn1$1.Class = {
    UNIVERSAL: 0,
    APPLICATION: 64,
    CONTEXT_SPECIFIC: 128,
    PRIVATE: 192
  };
  asn1$1.Type = {
    NONE: 0,
    BOOLEAN: 1,
    INTEGER: 2,
    BITSTRING: 3,
    OCTETSTRING: 4,
    NULL: 5,
    OID: 6,
    ODESC: 7,
    EXTERNAL: 8,
    REAL: 9,
    ENUMERATED: 10,
    EMBEDDED: 11,
    UTF8: 12,
    ROID: 13,
    SEQUENCE: 16,
    SET: 17,
    PRINTABLESTRING: 19,
    IA5STRING: 22,
    UTCTIME: 23,
    GENERALIZEDTIME: 24,
    BMPSTRING: 30
  };
  asn1$1.maxDepth = 256;
  asn1$1.create = function(tagClass, type, constructed, value, options) {
    if (forge2.util.isArray(value)) {
      var tmp = [];
      for (var i = 0; i < value.length; ++i) {
        if (value[i] !== void 0) {
          tmp.push(value[i]);
        }
      }
      value = tmp;
    }
    var obj = {
      tagClass,
      type,
      constructed,
      composed: constructed || forge2.util.isArray(value),
      value
    };
    if (options && "bitStringContents" in options) {
      obj.bitStringContents = options.bitStringContents;
      obj.original = asn1$1.copy(obj);
    }
    return obj;
  };
  asn1$1.copy = function(obj, options) {
    var copy2;
    if (forge2.util.isArray(obj)) {
      copy2 = [];
      for (var i = 0; i < obj.length; ++i) {
        copy2.push(asn1$1.copy(obj[i], options));
      }
      return copy2;
    }
    if (typeof obj === "string") {
      return obj;
    }
    copy2 = {
      tagClass: obj.tagClass,
      type: obj.type,
      constructed: obj.constructed,
      composed: obj.composed,
      value: asn1$1.copy(obj.value, options)
    };
    if (options && !options.excludeBitStringContents) {
      copy2.bitStringContents = obj.bitStringContents;
    }
    return copy2;
  };
  asn1$1.equals = function(obj1, obj2, options) {
    if (forge2.util.isArray(obj1)) {
      if (!forge2.util.isArray(obj2)) {
        return false;
      }
      if (obj1.length !== obj2.length) {
        return false;
      }
      for (var i = 0; i < obj1.length; ++i) {
        if (!asn1$1.equals(obj1[i], obj2[i])) {
          return false;
        }
      }
      return true;
    }
    if (typeof obj1 !== typeof obj2) {
      return false;
    }
    if (typeof obj1 === "string") {
      return obj1 === obj2;
    }
    var equal = obj1.tagClass === obj2.tagClass && obj1.type === obj2.type && obj1.constructed === obj2.constructed && obj1.composed === obj2.composed && asn1$1.equals(obj1.value, obj2.value);
    if (options && options.includeBitStringContents) {
      equal = equal && obj1.bitStringContents === obj2.bitStringContents;
    }
    return equal;
  };
  asn1$1.getBerValueLength = function(b) {
    var b2 = b.getByte();
    if (b2 === 128) {
      return void 0;
    }
    var length;
    var longForm = b2 & 128;
    if (!longForm) {
      length = b2;
    } else {
      length = b.getInt((b2 & 127) << 3);
    }
    return length;
  };
  function _checkBufferLength(bytes, remaining, n) {
    if (n > remaining) {
      var error = new Error("Too few bytes to parse DER.");
      error.available = bytes.length();
      error.remaining = remaining;
      error.requested = n;
      throw error;
    }
  }
  var _getValueLength = function(bytes, remaining) {
    var b2 = bytes.getByte();
    remaining--;
    if (b2 === 128) {
      return void 0;
    }
    var length;
    var longForm = b2 & 128;
    if (!longForm) {
      length = b2;
    } else {
      var longFormBytes = b2 & 127;
      _checkBufferLength(bytes, remaining, longFormBytes);
      length = bytes.getInt(longFormBytes << 3);
    }
    if (length < 0) {
      throw new Error("Negative length: " + length);
    }
    return length;
  };
  asn1$1.fromDer = function(bytes, options) {
    if (options === void 0) {
      options = {
        strict: true,
        parseAllBytes: true,
        decodeBitStrings: true
      };
    }
    if (typeof options === "boolean") {
      options = {
        strict: options,
        parseAllBytes: true,
        decodeBitStrings: true
      };
    }
    if (!("strict" in options)) {
      options.strict = true;
    }
    if (!("parseAllBytes" in options)) {
      options.parseAllBytes = true;
    }
    if (!("decodeBitStrings" in options)) {
      options.decodeBitStrings = true;
    }
    if (!("maxDepth" in options)) {
      options.maxDepth = asn1$1.maxDepth;
    }
    if (typeof bytes === "string") {
      bytes = forge2.util.createBuffer(bytes);
    }
    var byteCount = bytes.length();
    var value = _fromDer(bytes, bytes.length(), 0, options);
    if (options.parseAllBytes && bytes.length() !== 0) {
      var error = new Error("Unparsed DER bytes remain after ASN.1 parsing.");
      error.byteCount = byteCount;
      error.remaining = bytes.length();
      throw error;
    }
    return value;
  };
  function _fromDer(bytes, remaining, depth, options) {
    if (depth >= options.maxDepth) {
      throw new Error("ASN.1 parsing error: Max depth exceeded.");
    }
    var start;
    _checkBufferLength(bytes, remaining, 2);
    var b1 = bytes.getByte();
    remaining--;
    var tagClass = b1 & 192;
    var type = b1 & 31;
    start = bytes.length();
    var length = _getValueLength(bytes, remaining);
    remaining -= start - bytes.length();
    if (length !== void 0 && length > remaining) {
      if (options.strict) {
        var error = new Error("Too few bytes to read ASN.1 value.");
        error.available = bytes.length();
        error.remaining = remaining;
        error.requested = length;
        throw error;
      }
      length = remaining;
    }
    var value;
    var bitStringContents;
    var constructed = (b1 & 32) === 32;
    if (constructed) {
      value = [];
      if (length === void 0) {
        for (; ; ) {
          _checkBufferLength(bytes, remaining, 2);
          if (bytes.bytes(2) === String.fromCharCode(0, 0)) {
            bytes.getBytes(2);
            remaining -= 2;
            break;
          }
          start = bytes.length();
          value.push(_fromDer(bytes, remaining, depth + 1, options));
          remaining -= start - bytes.length();
        }
      } else {
        while (length > 0) {
          start = bytes.length();
          value.push(_fromDer(bytes, length, depth + 1, options));
          remaining -= start - bytes.length();
          length -= start - bytes.length();
        }
      }
    }
    if (value === void 0 && tagClass === asn1$1.Class.UNIVERSAL && type === asn1$1.Type.BITSTRING) {
      bitStringContents = bytes.bytes(length);
    }
    if (value === void 0 && options.decodeBitStrings && tagClass === asn1$1.Class.UNIVERSAL && // FIXME: OCTET STRINGs not yet supported here
    // .. other parts of forge expect to decode OCTET STRINGs manually
    type === asn1$1.Type.BITSTRING && length > 1) {
      var savedRead = bytes.read;
      var savedRemaining = remaining;
      var unused = 0;
      if (type === asn1$1.Type.BITSTRING) {
        _checkBufferLength(bytes, remaining, 1);
        unused = bytes.getByte();
        remaining--;
      }
      if (unused === 0) {
        try {
          start = bytes.length();
          var subOptions = {
            // enforce strict mode to avoid parsing ASN.1 from plain data
            strict: true,
            decodeBitStrings: true
          };
          var composed = _fromDer(bytes, remaining, depth + 1, subOptions);
          var used = start - bytes.length();
          remaining -= used;
          if (type == asn1$1.Type.BITSTRING) {
            used++;
          }
          var tc = composed.tagClass;
          if (used === length && (tc === asn1$1.Class.UNIVERSAL || tc === asn1$1.Class.CONTEXT_SPECIFIC)) {
            value = [composed];
          }
        } catch (ex) {
        }
      }
      if (value === void 0) {
        bytes.read = savedRead;
        remaining = savedRemaining;
      }
    }
    if (value === void 0) {
      if (length === void 0) {
        if (options.strict) {
          throw new Error("Non-constructed ASN.1 object of indefinite length.");
        }
        length = remaining;
      }
      if (type === asn1$1.Type.BMPSTRING) {
        value = "";
        for (; length > 0; length -= 2) {
          _checkBufferLength(bytes, remaining, 2);
          value += String.fromCharCode(bytes.getInt16());
          remaining -= 2;
        }
      } else {
        value = bytes.getBytes(length);
        remaining -= length;
      }
    }
    var asn1Options = bitStringContents === void 0 ? null : {
      bitStringContents
    };
    return asn1$1.create(tagClass, type, constructed, value, asn1Options);
  }
  asn1$1.toDer = function(obj) {
    var bytes = forge2.util.createBuffer();
    var b1 = obj.tagClass | obj.type;
    var value = forge2.util.createBuffer();
    var useBitStringContents = false;
    if ("bitStringContents" in obj) {
      useBitStringContents = true;
      if (obj.original) {
        useBitStringContents = asn1$1.equals(obj, obj.original);
      }
    }
    if (useBitStringContents) {
      value.putBytes(obj.bitStringContents);
    } else if (obj.composed) {
      if (obj.constructed) {
        b1 |= 32;
      } else {
        value.putByte(0);
      }
      for (var i = 0; i < obj.value.length; ++i) {
        if (obj.value[i] !== void 0) {
          value.putBuffer(asn1$1.toDer(obj.value[i]));
        }
      }
    } else {
      if (obj.type === asn1$1.Type.BMPSTRING) {
        for (var i = 0; i < obj.value.length; ++i) {
          value.putInt16(obj.value.charCodeAt(i));
        }
      } else {
        if (obj.type === asn1$1.Type.INTEGER && obj.value.length > 1 && // leading 0x00 for positive integer
        (obj.value.charCodeAt(0) === 0 && (obj.value.charCodeAt(1) & 128) === 0 || // leading 0xFF for negative integer
        obj.value.charCodeAt(0) === 255 && (obj.value.charCodeAt(1) & 128) === 128)) {
          value.putBytes(obj.value.substr(1));
        } else {
          value.putBytes(obj.value);
        }
      }
    }
    bytes.putByte(b1);
    if (value.length() <= 127) {
      bytes.putByte(value.length() & 127);
    } else {
      var len = value.length();
      var lenBytes = "";
      do {
        lenBytes += String.fromCharCode(len & 255);
        len = len >>> 8;
      } while (len > 0);
      bytes.putByte(lenBytes.length | 128);
      for (var i = lenBytes.length - 1; i >= 0; --i) {
        bytes.putByte(lenBytes.charCodeAt(i));
      }
    }
    bytes.putBuffer(value);
    return bytes;
  };
  asn1$1.oidToDer = function(oid) {
    var values = oid.split(".");
    var bytes = forge2.util.createBuffer();
    bytes.putByte(40 * parseInt(values[0], 10) + parseInt(values[1], 10));
    var last, valueBytes, value, b;
    for (var i = 2; i < values.length; ++i) {
      last = true;
      valueBytes = [];
      value = parseInt(values[i], 10);
      if (value > 4294967295) {
        throw new Error("OID value too large; max is 32-bits.");
      }
      do {
        b = value & 127;
        value = value >>> 7;
        if (!last) {
          b |= 128;
        }
        valueBytes.push(b);
        last = false;
      } while (value > 0);
      for (var n = valueBytes.length - 1; n >= 0; --n) {
        bytes.putByte(valueBytes[n]);
      }
    }
    return bytes;
  };
  asn1$1.derToOid = function(bytes) {
    var oid;
    if (typeof bytes === "string") {
      bytes = forge2.util.createBuffer(bytes);
    }
    var b = bytes.getByte();
    oid = Math.floor(b / 40) + "." + b % 40;
    var value = 0;
    while (bytes.length() > 0) {
      if (value > 70368744177663) {
        throw new Error("OID value too large; max is 53-bits.");
      }
      b = bytes.getByte();
      value = value * 128;
      if (b & 128) {
        value += b & 127;
      } else {
        oid += "." + (value + b);
        value = 0;
      }
    }
    return oid;
  };
  asn1$1.utcTimeToDate = function(utc) {
    var date = /* @__PURE__ */ new Date();
    var year = parseInt(utc.substr(0, 2), 10);
    year = year >= 50 ? 1900 + year : 2e3 + year;
    var MM = parseInt(utc.substr(2, 2), 10) - 1;
    var DD = parseInt(utc.substr(4, 2), 10);
    var hh = parseInt(utc.substr(6, 2), 10);
    var mm = parseInt(utc.substr(8, 2), 10);
    var ss = 0;
    if (utc.length > 11) {
      var c = utc.charAt(10);
      var end = 10;
      if (c !== "+" && c !== "-") {
        ss = parseInt(utc.substr(10, 2), 10);
        end += 2;
      }
    }
    date.setUTCFullYear(year, MM, DD);
    date.setUTCHours(hh, mm, ss, 0);
    if (end) {
      c = utc.charAt(end);
      if (c === "+" || c === "-") {
        var hhoffset = parseInt(utc.substr(end + 1, 2), 10);
        var mmoffset = parseInt(utc.substr(end + 4, 2), 10);
        var offset = hhoffset * 60 + mmoffset;
        offset *= 6e4;
        if (c === "+") {
          date.setTime(+date - offset);
        } else {
          date.setTime(+date + offset);
        }
      }
    }
    return date;
  };
  asn1$1.generalizedTimeToDate = function(gentime) {
    var date = /* @__PURE__ */ new Date();
    var YYYY = parseInt(gentime.substr(0, 4), 10);
    var MM = parseInt(gentime.substr(4, 2), 10) - 1;
    var DD = parseInt(gentime.substr(6, 2), 10);
    var hh = parseInt(gentime.substr(8, 2), 10);
    var mm = parseInt(gentime.substr(10, 2), 10);
    var ss = parseInt(gentime.substr(12, 2), 10);
    var fff = 0;
    var offset = 0;
    var isUTC = false;
    if (gentime.charAt(gentime.length - 1) === "Z") {
      isUTC = true;
    }
    var end = gentime.length - 5, c = gentime.charAt(end);
    if (c === "+" || c === "-") {
      var hhoffset = parseInt(gentime.substr(end + 1, 2), 10);
      var mmoffset = parseInt(gentime.substr(end + 4, 2), 10);
      offset = hhoffset * 60 + mmoffset;
      offset *= 6e4;
      if (c === "+") {
        offset *= -1;
      }
      isUTC = true;
    }
    if (gentime.charAt(14) === ".") {
      fff = parseFloat(gentime.substr(14), 10) * 1e3;
    }
    if (isUTC) {
      date.setUTCFullYear(YYYY, MM, DD);
      date.setUTCHours(hh, mm, ss, fff);
      date.setTime(+date + offset);
    } else {
      date.setFullYear(YYYY, MM, DD);
      date.setHours(hh, mm, ss, fff);
    }
    return date;
  };
  asn1$1.dateToUtcTime = function(date) {
    if (typeof date === "string") {
      return date;
    }
    var rval = "";
    var format = [];
    format.push(("" + date.getUTCFullYear()).substr(2));
    format.push("" + (date.getUTCMonth() + 1));
    format.push("" + date.getUTCDate());
    format.push("" + date.getUTCHours());
    format.push("" + date.getUTCMinutes());
    format.push("" + date.getUTCSeconds());
    for (var i = 0; i < format.length; ++i) {
      if (format[i].length < 2) {
        rval += "0";
      }
      rval += format[i];
    }
    rval += "Z";
    return rval;
  };
  asn1$1.dateToGeneralizedTime = function(date) {
    if (typeof date === "string") {
      return date;
    }
    var rval = "";
    var format = [];
    format.push("" + date.getUTCFullYear());
    format.push("" + (date.getUTCMonth() + 1));
    format.push("" + date.getUTCDate());
    format.push("" + date.getUTCHours());
    format.push("" + date.getUTCMinutes());
    format.push("" + date.getUTCSeconds());
    for (var i = 0; i < format.length; ++i) {
      if (format[i].length < 2) {
        rval += "0";
      }
      rval += format[i];
    }
    rval += "Z";
    return rval;
  };
  asn1$1.integerToDer = function(x) {
    var rval = forge2.util.createBuffer();
    if (x >= -128 && x < 128) {
      return rval.putSignedInt(x, 8);
    }
    if (x >= -32768 && x < 32768) {
      return rval.putSignedInt(x, 16);
    }
    if (x >= -8388608 && x < 8388608) {
      return rval.putSignedInt(x, 24);
    }
    if (x >= -2147483648 && x < 2147483648) {
      return rval.putSignedInt(x, 32);
    }
    var error = new Error("Integer too large; max is 32-bits.");
    error.integer = x;
    throw error;
  };
  asn1$1.derToInteger = function(bytes) {
    if (typeof bytes === "string") {
      bytes = forge2.util.createBuffer(bytes);
    }
    var n = bytes.length() * 8;
    if (n > 32) {
      throw new Error("Integer too large; max is 32-bits.");
    }
    return bytes.getSignedInt(n);
  };
  asn1$1.validate = function(obj, v, capture, errors) {
    var rval = false;
    if ((obj.tagClass === v.tagClass || typeof v.tagClass === "undefined") && (obj.type === v.type || typeof v.type === "undefined")) {
      if (obj.constructed === v.constructed || typeof v.constructed === "undefined") {
        rval = true;
        if (v.value && forge2.util.isArray(v.value)) {
          var j = 0;
          for (var i = 0; rval && i < v.value.length; ++i) {
            var schemaItem = v.value[i];
            rval = !!schemaItem.optional;
            var objChild = obj.value[j];
            if (!objChild) {
              if (!schemaItem.optional) {
                rval = false;
                if (errors) {
                  errors.push("[" + v.name + '] Missing required element. Expected tag class "' + schemaItem.tagClass + '", type "' + schemaItem.type + '"');
                }
              }
              continue;
            }
            var schemaHasTag = typeof schemaItem.tagClass !== "undefined" && typeof schemaItem.type !== "undefined";
            if (schemaHasTag && (objChild.tagClass !== schemaItem.tagClass || objChild.type !== schemaItem.type)) {
              if (schemaItem.optional) {
                rval = true;
                continue;
              } else {
                rval = false;
                if (errors) {
                  errors.push("[" + v.name + "] Tag mismatch. Expected (" + schemaItem.tagClass + "," + schemaItem.type + "), got (" + objChild.tagClass + "," + objChild.type + ")");
                }
                break;
              }
            }
            var childRval = asn1$1.validate(objChild, schemaItem, capture, errors);
            if (childRval) {
              ++j;
              rval = true;
            } else if (schemaItem.optional) {
              rval = true;
            } else {
              rval = false;
              break;
            }
          }
        }
        if (rval && capture) {
          if (v.capture) {
            capture[v.capture] = obj.value;
          }
          if (v.captureAsn1) {
            capture[v.captureAsn1] = obj;
          }
          if (v.captureBitStringContents && "bitStringContents" in obj) {
            capture[v.captureBitStringContents] = obj.bitStringContents;
          }
          if (v.captureBitStringValue && "bitStringContents" in obj) {
            if (obj.bitStringContents.length < 2) {
              capture[v.captureBitStringValue] = "";
            } else {
              var unused = obj.bitStringContents.charCodeAt(0);
              if (unused !== 0) {
                throw new Error(
                  "captureBitStringValue only supported for zero unused bits"
                );
              }
              capture[v.captureBitStringValue] = obj.bitStringContents.slice(1);
            }
          }
        }
      } else if (errors) {
        errors.push(
          "[" + v.name + '] Expected constructed "' + v.constructed + '", got "' + obj.constructed + '"'
        );
      }
    } else if (errors) {
      if (obj.tagClass !== v.tagClass) {
        errors.push(
          "[" + v.name + '] Expected tag class "' + v.tagClass + '", got "' + obj.tagClass + '"'
        );
      }
      if (obj.type !== v.type) {
        errors.push(
          "[" + v.name + '] Expected type "' + v.type + '", got "' + obj.type + '"'
        );
      }
    }
    return rval;
  };
  var _nonLatinRegex = /[^\\u0000-\\u00ff]/;
  asn1$1.prettyPrint = function(obj, level, indentation) {
    var rval = "";
    level = level || 0;
    indentation = indentation || 2;
    if (level > 0) {
      rval += "\n";
    }
    var indent = "";
    for (var i = 0; i < level * indentation; ++i) {
      indent += " ";
    }
    rval += indent + "Tag: ";
    switch (obj.tagClass) {
      case asn1$1.Class.UNIVERSAL:
        rval += "Universal:";
        break;
      case asn1$1.Class.APPLICATION:
        rval += "Application:";
        break;
      case asn1$1.Class.CONTEXT_SPECIFIC:
        rval += "Context-Specific:";
        break;
      case asn1$1.Class.PRIVATE:
        rval += "Private:";
        break;
    }
    if (obj.tagClass === asn1$1.Class.UNIVERSAL) {
      rval += obj.type;
      switch (obj.type) {
        case asn1$1.Type.NONE:
          rval += " (None)";
          break;
        case asn1$1.Type.BOOLEAN:
          rval += " (Boolean)";
          break;
        case asn1$1.Type.INTEGER:
          rval += " (Integer)";
          break;
        case asn1$1.Type.BITSTRING:
          rval += " (Bit string)";
          break;
        case asn1$1.Type.OCTETSTRING:
          rval += " (Octet string)";
          break;
        case asn1$1.Type.NULL:
          rval += " (Null)";
          break;
        case asn1$1.Type.OID:
          rval += " (Object Identifier)";
          break;
        case asn1$1.Type.ODESC:
          rval += " (Object Descriptor)";
          break;
        case asn1$1.Type.EXTERNAL:
          rval += " (External or Instance of)";
          break;
        case asn1$1.Type.REAL:
          rval += " (Real)";
          break;
        case asn1$1.Type.ENUMERATED:
          rval += " (Enumerated)";
          break;
        case asn1$1.Type.EMBEDDED:
          rval += " (Embedded PDV)";
          break;
        case asn1$1.Type.UTF8:
          rval += " (UTF8)";
          break;
        case asn1$1.Type.ROID:
          rval += " (Relative Object Identifier)";
          break;
        case asn1$1.Type.SEQUENCE:
          rval += " (Sequence)";
          break;
        case asn1$1.Type.SET:
          rval += " (Set)";
          break;
        case asn1$1.Type.PRINTABLESTRING:
          rval += " (Printable String)";
          break;
        case asn1$1.Type.IA5String:
          rval += " (IA5String (ASCII))";
          break;
        case asn1$1.Type.UTCTIME:
          rval += " (UTC time)";
          break;
        case asn1$1.Type.GENERALIZEDTIME:
          rval += " (Generalized time)";
          break;
        case asn1$1.Type.BMPSTRING:
          rval += " (BMP String)";
          break;
      }
    } else {
      rval += obj.type;
    }
    rval += "\n";
    rval += indent + "Constructed: " + obj.constructed + "\n";
    if (obj.composed) {
      var subvalues = 0;
      var sub = "";
      for (var i = 0; i < obj.value.length; ++i) {
        if (obj.value[i] !== void 0) {
          subvalues += 1;
          sub += asn1$1.prettyPrint(obj.value[i], level + 1, indentation);
          if (i + 1 < obj.value.length) {
            sub += ",";
          }
        }
      }
      rval += indent + "Sub values: " + subvalues + sub;
    } else {
      rval += indent + "Value: ";
      if (obj.type === asn1$1.Type.OID) {
        var oid = asn1$1.derToOid(obj.value);
        rval += oid;
        if (forge2.pki && forge2.pki.oids) {
          if (oid in forge2.pki.oids) {
            rval += " (" + forge2.pki.oids[oid] + ") ";
          }
        }
      }
      if (obj.type === asn1$1.Type.INTEGER) {
        try {
          rval += asn1$1.derToInteger(obj.value);
        } catch (ex) {
          rval += "0x" + forge2.util.bytesToHex(obj.value);
        }
      } else if (obj.type === asn1$1.Type.BITSTRING) {
        if (obj.value.length > 1) {
          rval += "0x" + forge2.util.bytesToHex(obj.value.slice(1));
        } else {
          rval += "(none)";
        }
        if (obj.value.length > 0) {
          var unused = obj.value.charCodeAt(0);
          if (unused == 1) {
            rval += " (1 unused bit shown)";
          } else if (unused > 1) {
            rval += " (" + unused + " unused bits shown)";
          }
        }
      } else if (obj.type === asn1$1.Type.OCTETSTRING) {
        if (!_nonLatinRegex.test(obj.value)) {
          rval += "(" + obj.value + ") ";
        }
        rval += "0x" + forge2.util.bytesToHex(obj.value);
      } else if (obj.type === asn1$1.Type.UTF8) {
        try {
          rval += forge2.util.decodeUtf8(obj.value);
        } catch (e) {
          if (e.message === "URI malformed") {
            rval += "0x" + forge2.util.bytesToHex(obj.value) + " (malformed UTF8)";
          } else {
            throw e;
          }
        }
      } else if (obj.type === asn1$1.Type.PRINTABLESTRING || obj.type === asn1$1.Type.IA5String) {
        rval += obj.value;
      } else if (_nonLatinRegex.test(obj.value)) {
        rval += "0x" + forge2.util.bytesToHex(obj.value);
      } else if (obj.value.length === 0) {
        rval += "[null]";
      } else {
        rval += obj.value;
      }
    }
    return rval;
  };
  return asn1.exports;
}
var hmac = { exports: {} };
var md;
var hasRequiredMd;
function requireMd() {
  if (hasRequiredMd) return md;
  hasRequiredMd = 1;
  var forge2 = requireForge();
  md = forge2.md = forge2.md || {};
  forge2.md.algorithms = forge2.md.algorithms || {};
  return md;
}
var hasRequiredHmac;
function requireHmac() {
  if (hasRequiredHmac) return hmac.exports;
  hasRequiredHmac = 1;
  var forge2 = requireForge();
  requireMd();
  requireUtil();
  var hmac$1 = hmac.exports = forge2.hmac = forge2.hmac || {};
  hmac$1.create = function() {
    var _key = null;
    var _md = null;
    var _ipadding = null;
    var _opadding = null;
    var ctx = {};
    ctx.start = function(md2, key) {
      if (md2 !== null) {
        if (typeof md2 === "string") {
          md2 = md2.toLowerCase();
          if (md2 in forge2.md.algorithms) {
            _md = forge2.md.algorithms[md2].create();
          } else {
            throw new Error('Unknown hash algorithm "' + md2 + '"');
          }
        } else {
          _md = md2;
        }
      }
      if (key === null) {
        key = _key;
      } else {
        if (typeof key === "string") {
          key = forge2.util.createBuffer(key);
        } else if (forge2.util.isArray(key)) {
          var tmp = key;
          key = forge2.util.createBuffer();
          for (var i = 0; i < tmp.length; ++i) {
            key.putByte(tmp[i]);
          }
        }
        var keylen = key.length();
        if (keylen > _md.blockLength) {
          _md.start();
          _md.update(key.bytes());
          key = _md.digest();
        }
        _ipadding = forge2.util.createBuffer();
        _opadding = forge2.util.createBuffer();
        keylen = key.length();
        for (var i = 0; i < keylen; ++i) {
          var tmp = key.at(i);
          _ipadding.putByte(54 ^ tmp);
          _opadding.putByte(92 ^ tmp);
        }
        if (keylen < _md.blockLength) {
          var tmp = _md.blockLength - keylen;
          for (var i = 0; i < tmp; ++i) {
            _ipadding.putByte(54);
            _opadding.putByte(92);
          }
        }
        _key = key;
        _ipadding = _ipadding.bytes();
        _opadding = _opadding.bytes();
      }
      _md.start();
      _md.update(_ipadding);
    };
    ctx.update = function(bytes) {
      _md.update(bytes);
    };
    ctx.getMac = function() {
      var inner = _md.digest().bytes();
      _md.start();
      _md.update(_opadding);
      _md.update(inner);
      return _md.digest();
    };
    ctx.digest = ctx.getMac;
    return ctx;
  };
  return hmac.exports;
}
var md5 = { exports: {} };
var hasRequiredMd5;
function requireMd5() {
  if (hasRequiredMd5) return md5.exports;
  hasRequiredMd5 = 1;
  var forge2 = requireForge();
  requireMd();
  requireUtil();
  var md5$1 = md5.exports = forge2.md5 = forge2.md5 || {};
  forge2.md.md5 = forge2.md.algorithms.md5 = md5$1;
  md5$1.create = function() {
    if (!_initialized) {
      _init();
    }
    var _state = null;
    var _input = forge2.util.createBuffer();
    var _w = new Array(16);
    var md2 = {
      algorithm: "md5",
      blockLength: 64,
      digestLength: 16,
      // 56-bit length of message so far (does not including padding)
      messageLength: 0,
      // true message length
      fullMessageLength: null,
      // size of message length in bytes
      messageLengthSize: 8
    };
    md2.start = function() {
      md2.messageLength = 0;
      md2.fullMessageLength = md2.messageLength64 = [];
      var int32s = md2.messageLengthSize / 4;
      for (var i = 0; i < int32s; ++i) {
        md2.fullMessageLength.push(0);
      }
      _input = forge2.util.createBuffer();
      _state = {
        h0: 1732584193,
        h1: 4023233417,
        h2: 2562383102,
        h3: 271733878
      };
      return md2;
    };
    md2.start();
    md2.update = function(msg, encoding) {
      if (encoding === "utf8") {
        msg = forge2.util.encodeUtf8(msg);
      }
      var len = msg.length;
      md2.messageLength += len;
      len = [len / 4294967296 >>> 0, len >>> 0];
      for (var i = md2.fullMessageLength.length - 1; i >= 0; --i) {
        md2.fullMessageLength[i] += len[1];
        len[1] = len[0] + (md2.fullMessageLength[i] / 4294967296 >>> 0);
        md2.fullMessageLength[i] = md2.fullMessageLength[i] >>> 0;
        len[0] = len[1] / 4294967296 >>> 0;
      }
      _input.putBytes(msg);
      _update(_state, _w, _input);
      if (_input.read > 2048 || _input.length() === 0) {
        _input.compact();
      }
      return md2;
    };
    md2.digest = function() {
      var finalBlock = forge2.util.createBuffer();
      finalBlock.putBytes(_input.bytes());
      var remaining = md2.fullMessageLength[md2.fullMessageLength.length - 1] + md2.messageLengthSize;
      var overflow = remaining & md2.blockLength - 1;
      finalBlock.putBytes(_padding.substr(0, md2.blockLength - overflow));
      var bits, carry = 0;
      for (var i = md2.fullMessageLength.length - 1; i >= 0; --i) {
        bits = md2.fullMessageLength[i] * 8 + carry;
        carry = bits / 4294967296 >>> 0;
        finalBlock.putInt32Le(bits >>> 0);
      }
      var s2 = {
        h0: _state.h0,
        h1: _state.h1,
        h2: _state.h2,
        h3: _state.h3
      };
      _update(s2, _w, finalBlock);
      var rval = forge2.util.createBuffer();
      rval.putInt32Le(s2.h0);
      rval.putInt32Le(s2.h1);
      rval.putInt32Le(s2.h2);
      rval.putInt32Le(s2.h3);
      return rval;
    };
    return md2;
  };
  var _padding = null;
  var _g = null;
  var _r = null;
  var _k = null;
  var _initialized = false;
  function _init() {
    _padding = String.fromCharCode(128);
    _padding += forge2.util.fillString(String.fromCharCode(0), 64);
    _g = [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      1,
      6,
      11,
      0,
      5,
      10,
      15,
      4,
      9,
      14,
      3,
      8,
      13,
      2,
      7,
      12,
      5,
      8,
      11,
      14,
      1,
      4,
      7,
      10,
      13,
      0,
      3,
      6,
      9,
      12,
      15,
      2,
      0,
      7,
      14,
      5,
      12,
      3,
      10,
      1,
      8,
      15,
      6,
      13,
      4,
      11,
      2,
      9
    ];
    _r = [
      7,
      12,
      17,
      22,
      7,
      12,
      17,
      22,
      7,
      12,
      17,
      22,
      7,
      12,
      17,
      22,
      5,
      9,
      14,
      20,
      5,
      9,
      14,
      20,
      5,
      9,
      14,
      20,
      5,
      9,
      14,
      20,
      4,
      11,
      16,
      23,
      4,
      11,
      16,
      23,
      4,
      11,
      16,
      23,
      4,
      11,
      16,
      23,
      6,
      10,
      15,
      21,
      6,
      10,
      15,
      21,
      6,
      10,
      15,
      21,
      6,
      10,
      15,
      21
    ];
    _k = new Array(64);
    for (var i = 0; i < 64; ++i) {
      _k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    }
    _initialized = true;
  }
  function _update(s, w, bytes) {
    var t, a, b, c, d, f, r, i;
    var len = bytes.length();
    while (len >= 64) {
      a = s.h0;
      b = s.h1;
      c = s.h2;
      d = s.h3;
      for (i = 0; i < 16; ++i) {
        w[i] = bytes.getInt32Le();
        f = d ^ b & (c ^ d);
        t = a + f + _k[i] + w[i];
        r = _r[i];
        a = d;
        d = c;
        c = b;
        b += t << r | t >>> 32 - r;
      }
      for (; i < 32; ++i) {
        f = c ^ d & (b ^ c);
        t = a + f + _k[i] + w[_g[i]];
        r = _r[i];
        a = d;
        d = c;
        c = b;
        b += t << r | t >>> 32 - r;
      }
      for (; i < 48; ++i) {
        f = b ^ c ^ d;
        t = a + f + _k[i] + w[_g[i]];
        r = _r[i];
        a = d;
        d = c;
        c = b;
        b += t << r | t >>> 32 - r;
      }
      for (; i < 64; ++i) {
        f = c ^ (b | ~d);
        t = a + f + _k[i] + w[_g[i]];
        r = _r[i];
        a = d;
        d = c;
        c = b;
        b += t << r | t >>> 32 - r;
      }
      s.h0 = s.h0 + a | 0;
      s.h1 = s.h1 + b | 0;
      s.h2 = s.h2 + c | 0;
      s.h3 = s.h3 + d | 0;
      len -= 64;
    }
  }
  return md5.exports;
}
var pem = { exports: {} };
var hasRequiredPem;
function requirePem() {
  if (hasRequiredPem) return pem.exports;
  hasRequiredPem = 1;
  var forge2 = requireForge();
  requireUtil();
  var pem$1 = pem.exports = forge2.pem = forge2.pem || {};
  pem$1.encode = function(msg, options) {
    options = options || {};
    var rval = "-----BEGIN " + msg.type + "-----\r\n";
    var header;
    if (msg.procType) {
      header = {
        name: "Proc-Type",
        values: [String(msg.procType.version), msg.procType.type]
      };
      rval += foldHeader(header);
    }
    if (msg.contentDomain) {
      header = { name: "Content-Domain", values: [msg.contentDomain] };
      rval += foldHeader(header);
    }
    if (msg.dekInfo) {
      header = { name: "DEK-Info", values: [msg.dekInfo.algorithm] };
      if (msg.dekInfo.parameters) {
        header.values.push(msg.dekInfo.parameters);
      }
      rval += foldHeader(header);
    }
    if (msg.headers) {
      for (var i = 0; i < msg.headers.length; ++i) {
        rval += foldHeader(msg.headers[i]);
      }
    }
    if (msg.procType) {
      rval += "\r\n";
    }
    rval += forge2.util.encode64(msg.body, options.maxline || 64) + "\r\n";
    rval += "-----END " + msg.type + "-----\r\n";
    return rval;
  };
  pem$1.decode = function(str) {
    var rval = [];
    var rMessage = /\s*-----BEGIN ([A-Z0-9- ]+)-----\r?\n?([\x21-\x7e\s]+?(?:\r?\n\r?\n))?([:A-Za-z0-9+\/=\s]+?)-----END \1-----/g;
    var rHeader = /([\x21-\x7e]+):\s*([\x21-\x7e\s^:]+)/;
    var rCRLF = /\r?\n/;
    var match;
    while (true) {
      match = rMessage.exec(str);
      if (!match) {
        break;
      }
      var type = match[1];
      if (type === "NEW CERTIFICATE REQUEST") {
        type = "CERTIFICATE REQUEST";
      }
      var msg = {
        type,
        procType: null,
        contentDomain: null,
        dekInfo: null,
        headers: [],
        body: forge2.util.decode64(match[3])
      };
      rval.push(msg);
      if (!match[2]) {
        continue;
      }
      var lines = match[2].split(rCRLF);
      var li = 0;
      while (match && li < lines.length) {
        var line = lines[li].replace(/\s+$/, "");
        for (var nl = li + 1; nl < lines.length; ++nl) {
          var next = lines[nl];
          if (!/\s/.test(next[0])) {
            break;
          }
          line += next;
          li = nl;
        }
        match = line.match(rHeader);
        if (match) {
          var header = { name: match[1], values: [] };
          var values = match[2].split(",");
          for (var vi = 0; vi < values.length; ++vi) {
            header.values.push(ltrim(values[vi]));
          }
          if (!msg.procType) {
            if (header.name !== "Proc-Type") {
              throw new Error('Invalid PEM formatted message. The first encapsulated header must be "Proc-Type".');
            } else if (header.values.length !== 2) {
              throw new Error('Invalid PEM formatted message. The "Proc-Type" header must have two subfields.');
            }
            msg.procType = { version: values[0], type: values[1] };
          } else if (!msg.contentDomain && header.name === "Content-Domain") {
            msg.contentDomain = values[0] || "";
          } else if (!msg.dekInfo && header.name === "DEK-Info") {
            if (header.values.length === 0) {
              throw new Error('Invalid PEM formatted message. The "DEK-Info" header must have at least one subfield.');
            }
            msg.dekInfo = { algorithm: values[0], parameters: values[1] || null };
          } else {
            msg.headers.push(header);
          }
        }
        ++li;
      }
      if (msg.procType === "ENCRYPTED" && !msg.dekInfo) {
        throw new Error('Invalid PEM formatted message. The "DEK-Info" header must be present if "Proc-Type" is "ENCRYPTED".');
      }
    }
    if (rval.length === 0) {
      throw new Error("Invalid PEM formatted message.");
    }
    return rval;
  };
  function foldHeader(header) {
    var rval = header.name + ": ";
    var values = [];
    var insertSpace = function(match, $1) {
      return " " + $1;
    };
    for (var i = 0; i < header.values.length; ++i) {
      values.push(header.values[i].replace(/^(\S+\r\n)/, insertSpace));
    }
    rval += values.join(",") + "\r\n";
    var length = 0;
    var candidate = -1;
    for (var i = 0; i < rval.length; ++i, ++length) {
      if (length > 65 && candidate !== -1) {
        var insert = rval[candidate];
        if (insert === ",") {
          ++candidate;
          rval = rval.substr(0, candidate) + "\r\n " + rval.substr(candidate);
        } else {
          rval = rval.substr(0, candidate) + "\r\n" + insert + rval.substr(candidate + 1);
        }
        length = i - candidate - 1;
        candidate = -1;
        ++i;
      } else if (rval[i] === " " || rval[i] === "	" || rval[i] === ",") {
        candidate = i;
      }
    }
    return rval;
  }
  function ltrim(str) {
    return str.replace(/^\s+/, "");
  }
  return pem.exports;
}
var pki = { exports: {} };
var des;
var hasRequiredDes;
function requireDes() {
  if (hasRequiredDes) return des;
  hasRequiredDes = 1;
  var forge2 = requireForge();
  requireCipher();
  requireCipherModes();
  requireUtil();
  des = forge2.des = forge2.des || {};
  forge2.des.startEncrypting = function(key, iv, output, mode) {
    var cipher2 = _createCipher({
      key,
      output,
      decrypt: false,
      mode: mode || (iv === null ? "ECB" : "CBC")
    });
    cipher2.start(iv);
    return cipher2;
  };
  forge2.des.createEncryptionCipher = function(key, mode) {
    return _createCipher({
      key,
      output: null,
      decrypt: false,
      mode
    });
  };
  forge2.des.startDecrypting = function(key, iv, output, mode) {
    var cipher2 = _createCipher({
      key,
      output,
      decrypt: true,
      mode: mode || (iv === null ? "ECB" : "CBC")
    });
    cipher2.start(iv);
    return cipher2;
  };
  forge2.des.createDecryptionCipher = function(key, mode) {
    return _createCipher({
      key,
      output: null,
      decrypt: true,
      mode
    });
  };
  forge2.des.Algorithm = function(name, mode) {
    var self2 = this;
    self2.name = name;
    self2.mode = new mode({
      blockSize: 8,
      cipher: {
        encrypt: function(inBlock, outBlock) {
          return _updateBlock(self2._keys, inBlock, outBlock, false);
        },
        decrypt: function(inBlock, outBlock) {
          return _updateBlock(self2._keys, inBlock, outBlock, true);
        }
      }
    });
    self2._init = false;
  };
  forge2.des.Algorithm.prototype.initialize = function(options) {
    if (this._init) {
      return;
    }
    var key = forge2.util.createBuffer(options.key);
    if (this.name.indexOf("3DES") === 0) {
      if (key.length() !== 24) {
        throw new Error("Invalid Triple-DES key size: " + key.length() * 8);
      }
    }
    this._keys = _createKeys(key);
    this._init = true;
  };
  registerAlgorithm("DES-ECB", forge2.cipher.modes.ecb);
  registerAlgorithm("DES-CBC", forge2.cipher.modes.cbc);
  registerAlgorithm("DES-CFB", forge2.cipher.modes.cfb);
  registerAlgorithm("DES-OFB", forge2.cipher.modes.ofb);
  registerAlgorithm("DES-CTR", forge2.cipher.modes.ctr);
  registerAlgorithm("3DES-ECB", forge2.cipher.modes.ecb);
  registerAlgorithm("3DES-CBC", forge2.cipher.modes.cbc);
  registerAlgorithm("3DES-CFB", forge2.cipher.modes.cfb);
  registerAlgorithm("3DES-OFB", forge2.cipher.modes.ofb);
  registerAlgorithm("3DES-CTR", forge2.cipher.modes.ctr);
  function registerAlgorithm(name, mode) {
    var factory = function() {
      return new forge2.des.Algorithm(name, mode);
    };
    forge2.cipher.registerAlgorithm(name, factory);
  }
  var spfunction1 = [16843776, 0, 65536, 16843780, 16842756, 66564, 4, 65536, 1024, 16843776, 16843780, 1024, 16778244, 16842756, 16777216, 4, 1028, 16778240, 16778240, 66560, 66560, 16842752, 16842752, 16778244, 65540, 16777220, 16777220, 65540, 0, 1028, 66564, 16777216, 65536, 16843780, 4, 16842752, 16843776, 16777216, 16777216, 1024, 16842756, 65536, 66560, 16777220, 1024, 4, 16778244, 66564, 16843780, 65540, 16842752, 16778244, 16777220, 1028, 66564, 16843776, 1028, 16778240, 16778240, 0, 65540, 66560, 0, 16842756];
  var spfunction2 = [-2146402272, -2147450880, 32768, 1081376, 1048576, 32, -2146435040, -2147450848, -2147483616, -2146402272, -2146402304, -2147483648, -2147450880, 1048576, 32, -2146435040, 1081344, 1048608, -2147450848, 0, -2147483648, 32768, 1081376, -2146435072, 1048608, -2147483616, 0, 1081344, 32800, -2146402304, -2146435072, 32800, 0, 1081376, -2146435040, 1048576, -2147450848, -2146435072, -2146402304, 32768, -2146435072, -2147450880, 32, -2146402272, 1081376, 32, 32768, -2147483648, 32800, -2146402304, 1048576, -2147483616, 1048608, -2147450848, -2147483616, 1048608, 1081344, 0, -2147450880, 32800, -2147483648, -2146435040, -2146402272, 1081344];
  var spfunction3 = [520, 134349312, 0, 134348808, 134218240, 0, 131592, 134218240, 131080, 134217736, 134217736, 131072, 134349320, 131080, 134348800, 520, 134217728, 8, 134349312, 512, 131584, 134348800, 134348808, 131592, 134218248, 131584, 131072, 134218248, 8, 134349320, 512, 134217728, 134349312, 134217728, 131080, 520, 131072, 134349312, 134218240, 0, 512, 131080, 134349320, 134218240, 134217736, 512, 0, 134348808, 134218248, 131072, 134217728, 134349320, 8, 131592, 131584, 134217736, 134348800, 134218248, 520, 134348800, 131592, 8, 134348808, 131584];
  var spfunction4 = [8396801, 8321, 8321, 128, 8396928, 8388737, 8388609, 8193, 0, 8396800, 8396800, 8396929, 129, 0, 8388736, 8388609, 1, 8192, 8388608, 8396801, 128, 8388608, 8193, 8320, 8388737, 1, 8320, 8388736, 8192, 8396928, 8396929, 129, 8388736, 8388609, 8396800, 8396929, 129, 0, 0, 8396800, 8320, 8388736, 8388737, 1, 8396801, 8321, 8321, 128, 8396929, 129, 1, 8192, 8388609, 8193, 8396928, 8388737, 8193, 8320, 8388608, 8396801, 128, 8388608, 8192, 8396928];
  var spfunction5 = [256, 34078976, 34078720, 1107296512, 524288, 256, 1073741824, 34078720, 1074266368, 524288, 33554688, 1074266368, 1107296512, 1107820544, 524544, 1073741824, 33554432, 1074266112, 1074266112, 0, 1073742080, 1107820800, 1107820800, 33554688, 1107820544, 1073742080, 0, 1107296256, 34078976, 33554432, 1107296256, 524544, 524288, 1107296512, 256, 33554432, 1073741824, 34078720, 1107296512, 1074266368, 33554688, 1073741824, 1107820544, 34078976, 1074266368, 256, 33554432, 1107820544, 1107820800, 524544, 1107296256, 1107820800, 34078720, 0, 1074266112, 1107296256, 524544, 33554688, 1073742080, 524288, 0, 1074266112, 34078976, 1073742080];
  var spfunction6 = [536870928, 541065216, 16384, 541081616, 541065216, 16, 541081616, 4194304, 536887296, 4210704, 4194304, 536870928, 4194320, 536887296, 536870912, 16400, 0, 4194320, 536887312, 16384, 4210688, 536887312, 16, 541065232, 541065232, 0, 4210704, 541081600, 16400, 4210688, 541081600, 536870912, 536887296, 16, 541065232, 4210688, 541081616, 4194304, 16400, 536870928, 4194304, 536887296, 536870912, 16400, 536870928, 541081616, 4210688, 541065216, 4210704, 541081600, 0, 541065232, 16, 16384, 541065216, 4210704, 16384, 4194320, 536887312, 0, 541081600, 536870912, 4194320, 536887312];
  var spfunction7 = [2097152, 69206018, 67110914, 0, 2048, 67110914, 2099202, 69208064, 69208066, 2097152, 0, 67108866, 2, 67108864, 69206018, 2050, 67110912, 2099202, 2097154, 67110912, 67108866, 69206016, 69208064, 2097154, 69206016, 2048, 2050, 69208066, 2099200, 2, 67108864, 2099200, 67108864, 2099200, 2097152, 67110914, 67110914, 69206018, 69206018, 2, 2097154, 67108864, 67110912, 2097152, 69208064, 2050, 2099202, 69208064, 2050, 67108866, 69208066, 69206016, 2099200, 0, 2, 69208066, 0, 2099202, 69206016, 2048, 67108866, 67110912, 2048, 2097154];
  var spfunction8 = [268439616, 4096, 262144, 268701760, 268435456, 268439616, 64, 268435456, 262208, 268697600, 268701760, 266240, 268701696, 266304, 4096, 64, 268697600, 268435520, 268439552, 4160, 266240, 262208, 268697664, 268701696, 4160, 0, 0, 268697664, 268435520, 268439552, 266304, 262144, 266304, 262144, 268701696, 4096, 64, 268697664, 4096, 266304, 268439552, 64, 268435520, 268697600, 268697664, 268435456, 262144, 268439616, 0, 268701760, 262208, 268435520, 268697600, 268439552, 268439616, 0, 268701760, 266240, 266240, 4160, 4160, 262208, 268435456, 268701696];
  function _createKeys(key) {
    var pc2bytes0 = [0, 4, 536870912, 536870916, 65536, 65540, 536936448, 536936452, 512, 516, 536871424, 536871428, 66048, 66052, 536936960, 536936964], pc2bytes1 = [0, 1, 1048576, 1048577, 67108864, 67108865, 68157440, 68157441, 256, 257, 1048832, 1048833, 67109120, 67109121, 68157696, 68157697], pc2bytes2 = [0, 8, 2048, 2056, 16777216, 16777224, 16779264, 16779272, 0, 8, 2048, 2056, 16777216, 16777224, 16779264, 16779272], pc2bytes3 = [0, 2097152, 134217728, 136314880, 8192, 2105344, 134225920, 136323072, 131072, 2228224, 134348800, 136445952, 139264, 2236416, 134356992, 136454144], pc2bytes4 = [0, 262144, 16, 262160, 0, 262144, 16, 262160, 4096, 266240, 4112, 266256, 4096, 266240, 4112, 266256], pc2bytes5 = [0, 1024, 32, 1056, 0, 1024, 32, 1056, 33554432, 33555456, 33554464, 33555488, 33554432, 33555456, 33554464, 33555488], pc2bytes6 = [0, 268435456, 524288, 268959744, 2, 268435458, 524290, 268959746, 0, 268435456, 524288, 268959744, 2, 268435458, 524290, 268959746], pc2bytes7 = [0, 65536, 2048, 67584, 536870912, 536936448, 536872960, 536938496, 131072, 196608, 133120, 198656, 537001984, 537067520, 537004032, 537069568], pc2bytes8 = [0, 262144, 0, 262144, 2, 262146, 2, 262146, 33554432, 33816576, 33554432, 33816576, 33554434, 33816578, 33554434, 33816578], pc2bytes9 = [0, 268435456, 8, 268435464, 0, 268435456, 8, 268435464, 1024, 268436480, 1032, 268436488, 1024, 268436480, 1032, 268436488], pc2bytes10 = [0, 32, 0, 32, 1048576, 1048608, 1048576, 1048608, 8192, 8224, 8192, 8224, 1056768, 1056800, 1056768, 1056800], pc2bytes11 = [0, 16777216, 512, 16777728, 2097152, 18874368, 2097664, 18874880, 67108864, 83886080, 67109376, 83886592, 69206016, 85983232, 69206528, 85983744], pc2bytes12 = [0, 4096, 134217728, 134221824, 524288, 528384, 134742016, 134746112, 16, 4112, 134217744, 134221840, 524304, 528400, 134742032, 134746128], pc2bytes13 = [0, 4, 256, 260, 0, 4, 256, 260, 1, 5, 257, 261, 1, 5, 257, 261];
    var iterations = key.length() > 8 ? 3 : 1;
    var keys = [];
    var shifts = [0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0];
    var n = 0, tmp;
    for (var j = 0; j < iterations; j++) {
      var left = key.getInt32();
      var right = key.getInt32();
      tmp = (left >>> 4 ^ right) & 252645135;
      right ^= tmp;
      left ^= tmp << 4;
      tmp = (right >>> -16 ^ left) & 65535;
      left ^= tmp;
      right ^= tmp << -16;
      tmp = (left >>> 2 ^ right) & 858993459;
      right ^= tmp;
      left ^= tmp << 2;
      tmp = (right >>> -16 ^ left) & 65535;
      left ^= tmp;
      right ^= tmp << -16;
      tmp = (left >>> 1 ^ right) & 1431655765;
      right ^= tmp;
      left ^= tmp << 1;
      tmp = (right >>> 8 ^ left) & 16711935;
      left ^= tmp;
      right ^= tmp << 8;
      tmp = (left >>> 1 ^ right) & 1431655765;
      right ^= tmp;
      left ^= tmp << 1;
      tmp = left << 8 | right >>> 20 & 240;
      left = right << 24 | right << 8 & 16711680 | right >>> 8 & 65280 | right >>> 24 & 240;
      right = tmp;
      for (var i = 0; i < shifts.length; ++i) {
        if (shifts[i]) {
          left = left << 2 | left >>> 26;
          right = right << 2 | right >>> 26;
        } else {
          left = left << 1 | left >>> 27;
          right = right << 1 | right >>> 27;
        }
        left &= -15;
        right &= -15;
        var lefttmp = pc2bytes0[left >>> 28] | pc2bytes1[left >>> 24 & 15] | pc2bytes2[left >>> 20 & 15] | pc2bytes3[left >>> 16 & 15] | pc2bytes4[left >>> 12 & 15] | pc2bytes5[left >>> 8 & 15] | pc2bytes6[left >>> 4 & 15];
        var righttmp = pc2bytes7[right >>> 28] | pc2bytes8[right >>> 24 & 15] | pc2bytes9[right >>> 20 & 15] | pc2bytes10[right >>> 16 & 15] | pc2bytes11[right >>> 12 & 15] | pc2bytes12[right >>> 8 & 15] | pc2bytes13[right >>> 4 & 15];
        tmp = (righttmp >>> 16 ^ lefttmp) & 65535;
        keys[n++] = lefttmp ^ tmp;
        keys[n++] = righttmp ^ tmp << 16;
      }
    }
    return keys;
  }
  function _updateBlock(keys, input, output, decrypt) {
    var iterations = keys.length === 32 ? 3 : 9;
    var looping;
    if (iterations === 3) {
      looping = decrypt ? [30, -2, -2] : [0, 32, 2];
    } else {
      looping = decrypt ? [94, 62, -2, 32, 64, 2, 30, -2, -2] : [0, 32, 2, 62, 30, -2, 64, 96, 2];
    }
    var tmp;
    var left = input[0];
    var right = input[1];
    tmp = (left >>> 4 ^ right) & 252645135;
    right ^= tmp;
    left ^= tmp << 4;
    tmp = (left >>> 16 ^ right) & 65535;
    right ^= tmp;
    left ^= tmp << 16;
    tmp = (right >>> 2 ^ left) & 858993459;
    left ^= tmp;
    right ^= tmp << 2;
    tmp = (right >>> 8 ^ left) & 16711935;
    left ^= tmp;
    right ^= tmp << 8;
    tmp = (left >>> 1 ^ right) & 1431655765;
    right ^= tmp;
    left ^= tmp << 1;
    left = left << 1 | left >>> 31;
    right = right << 1 | right >>> 31;
    for (var j = 0; j < iterations; j += 3) {
      var endloop = looping[j + 1];
      var loopinc = looping[j + 2];
      for (var i = looping[j]; i != endloop; i += loopinc) {
        var right1 = right ^ keys[i];
        var right2 = (right >>> 4 | right << 28) ^ keys[i + 1];
        tmp = left;
        left = right;
        right = tmp ^ (spfunction2[right1 >>> 24 & 63] | spfunction4[right1 >>> 16 & 63] | spfunction6[right1 >>> 8 & 63] | spfunction8[right1 & 63] | spfunction1[right2 >>> 24 & 63] | spfunction3[right2 >>> 16 & 63] | spfunction5[right2 >>> 8 & 63] | spfunction7[right2 & 63]);
      }
      tmp = left;
      left = right;
      right = tmp;
    }
    left = left >>> 1 | left << 31;
    right = right >>> 1 | right << 31;
    tmp = (left >>> 1 ^ right) & 1431655765;
    right ^= tmp;
    left ^= tmp << 1;
    tmp = (right >>> 8 ^ left) & 16711935;
    left ^= tmp;
    right ^= tmp << 8;
    tmp = (right >>> 2 ^ left) & 858993459;
    left ^= tmp;
    right ^= tmp << 2;
    tmp = (left >>> 16 ^ right) & 65535;
    right ^= tmp;
    left ^= tmp << 16;
    tmp = (left >>> 4 ^ right) & 252645135;
    right ^= tmp;
    left ^= tmp << 4;
    output[0] = left;
    output[1] = right;
  }
  function _createCipher(options) {
    options = options || {};
    var mode = (options.mode || "CBC").toUpperCase();
    var algorithm = "DES-" + mode;
    var cipher2;
    if (options.decrypt) {
      cipher2 = forge2.cipher.createDecipher(algorithm, options.key);
    } else {
      cipher2 = forge2.cipher.createCipher(algorithm, options.key);
    }
    var start = cipher2.start;
    cipher2.start = function(iv, options2) {
      var output = null;
      if (options2 instanceof forge2.util.ByteBuffer) {
        output = options2;
        options2 = {};
      }
      options2 = options2 || {};
      options2.output = output;
      options2.iv = iv;
      start.call(cipher2, options2);
    };
    return cipher2;
  }
  return des;
}
var pbkdf2;
var hasRequiredPbkdf2;
function requirePbkdf2() {
  if (hasRequiredPbkdf2) return pbkdf2;
  hasRequiredPbkdf2 = 1;
  var forge2 = requireForge();
  requireHmac();
  requireMd();
  requireUtil();
  var pkcs5 = forge2.pkcs5 = forge2.pkcs5 || {};
  var crypto;
  if (forge2.util.isNodejs && !forge2.options.usePureJavaScript) {
    crypto = require$$3;
  }
  pbkdf2 = forge2.pbkdf2 = pkcs5.pbkdf2 = function(p, s, c, dkLen, md2, callback) {
    if (typeof md2 === "function") {
      callback = md2;
      md2 = null;
    }
    if (forge2.util.isNodejs && !forge2.options.usePureJavaScript && crypto.pbkdf2 && (md2 === null || typeof md2 !== "object") && (crypto.pbkdf2Sync.length > 4 || (!md2 || md2 === "sha1"))) {
      if (typeof md2 !== "string") {
        md2 = "sha1";
      }
      p = Buffer.from(p, "binary");
      s = Buffer.from(s, "binary");
      if (!callback) {
        if (crypto.pbkdf2Sync.length === 4) {
          return crypto.pbkdf2Sync(p, s, c, dkLen).toString("binary");
        }
        return crypto.pbkdf2Sync(p, s, c, dkLen, md2).toString("binary");
      }
      if (crypto.pbkdf2Sync.length === 4) {
        return crypto.pbkdf2(p, s, c, dkLen, function(err2, key) {
          if (err2) {
            return callback(err2);
          }
          callback(null, key.toString("binary"));
        });
      }
      return crypto.pbkdf2(p, s, c, dkLen, md2, function(err2, key) {
        if (err2) {
          return callback(err2);
        }
        callback(null, key.toString("binary"));
      });
    }
    if (typeof md2 === "undefined" || md2 === null) {
      md2 = "sha1";
    }
    if (typeof md2 === "string") {
      if (!(md2 in forge2.md.algorithms)) {
        throw new Error("Unknown hash algorithm: " + md2);
      }
      md2 = forge2.md[md2].create();
    }
    var hLen = md2.digestLength;
    if (dkLen > 4294967295 * hLen) {
      var err = new Error("Derived key is too long.");
      if (callback) {
        return callback(err);
      }
      throw err;
    }
    var len = Math.ceil(dkLen / hLen);
    var r = dkLen - (len - 1) * hLen;
    var prf = forge2.hmac.create();
    prf.start(md2, p);
    var dk = "";
    var xor, u_c, u_c1;
    if (!callback) {
      for (var i = 1; i <= len; ++i) {
        prf.start(null, null);
        prf.update(s);
        prf.update(forge2.util.int32ToBytes(i));
        xor = u_c1 = prf.digest().getBytes();
        for (var j = 2; j <= c; ++j) {
          prf.start(null, null);
          prf.update(u_c1);
          u_c = prf.digest().getBytes();
          xor = forge2.util.xorBytes(xor, u_c, hLen);
          u_c1 = u_c;
        }
        dk += i < len ? xor : xor.substr(0, r);
      }
      return dk;
    }
    var i = 1, j;
    function outer() {
      if (i > len) {
        return callback(null, dk);
      }
      prf.start(null, null);
      prf.update(s);
      prf.update(forge2.util.int32ToBytes(i));
      xor = u_c1 = prf.digest().getBytes();
      j = 2;
      inner();
    }
    function inner() {
      if (j <= c) {
        prf.start(null, null);
        prf.update(u_c1);
        u_c = prf.digest().getBytes();
        xor = forge2.util.xorBytes(xor, u_c, hLen);
        u_c1 = u_c;
        ++j;
        return forge2.util.setImmediate(inner);
      }
      dk += i < len ? xor : xor.substr(0, r);
      ++i;
      outer();
    }
    outer();
  };
  return pbkdf2;
}
var random = { exports: {} };
var sha256 = { exports: {} };
var hasRequiredSha256;
function requireSha256() {
  if (hasRequiredSha256) return sha256.exports;
  hasRequiredSha256 = 1;
  var forge2 = requireForge();
  requireMd();
  requireUtil();
  var sha256$1 = sha256.exports = forge2.sha256 = forge2.sha256 || {};
  forge2.md.sha256 = forge2.md.algorithms.sha256 = sha256$1;
  sha256$1.create = function() {
    if (!_initialized) {
      _init();
    }
    var _state = null;
    var _input = forge2.util.createBuffer();
    var _w = new Array(64);
    var md2 = {
      algorithm: "sha256",
      blockLength: 64,
      digestLength: 32,
      // 56-bit length of message so far (does not including padding)
      messageLength: 0,
      // true message length
      fullMessageLength: null,
      // size of message length in bytes
      messageLengthSize: 8
    };
    md2.start = function() {
      md2.messageLength = 0;
      md2.fullMessageLength = md2.messageLength64 = [];
      var int32s = md2.messageLengthSize / 4;
      for (var i = 0; i < int32s; ++i) {
        md2.fullMessageLength.push(0);
      }
      _input = forge2.util.createBuffer();
      _state = {
        h0: 1779033703,
        h1: 3144134277,
        h2: 1013904242,
        h3: 2773480762,
        h4: 1359893119,
        h5: 2600822924,
        h6: 528734635,
        h7: 1541459225
      };
      return md2;
    };
    md2.start();
    md2.update = function(msg, encoding) {
      if (encoding === "utf8") {
        msg = forge2.util.encodeUtf8(msg);
      }
      var len = msg.length;
      md2.messageLength += len;
      len = [len / 4294967296 >>> 0, len >>> 0];
      for (var i = md2.fullMessageLength.length - 1; i >= 0; --i) {
        md2.fullMessageLength[i] += len[1];
        len[1] = len[0] + (md2.fullMessageLength[i] / 4294967296 >>> 0);
        md2.fullMessageLength[i] = md2.fullMessageLength[i] >>> 0;
        len[0] = len[1] / 4294967296 >>> 0;
      }
      _input.putBytes(msg);
      _update(_state, _w, _input);
      if (_input.read > 2048 || _input.length() === 0) {
        _input.compact();
      }
      return md2;
    };
    md2.digest = function() {
      var finalBlock = forge2.util.createBuffer();
      finalBlock.putBytes(_input.bytes());
      var remaining = md2.fullMessageLength[md2.fullMessageLength.length - 1] + md2.messageLengthSize;
      var overflow = remaining & md2.blockLength - 1;
      finalBlock.putBytes(_padding.substr(0, md2.blockLength - overflow));
      var next, carry;
      var bits = md2.fullMessageLength[0] * 8;
      for (var i = 0; i < md2.fullMessageLength.length - 1; ++i) {
        next = md2.fullMessageLength[i + 1] * 8;
        carry = next / 4294967296 >>> 0;
        bits += carry;
        finalBlock.putInt32(bits >>> 0);
        bits = next >>> 0;
      }
      finalBlock.putInt32(bits);
      var s2 = {
        h0: _state.h0,
        h1: _state.h1,
        h2: _state.h2,
        h3: _state.h3,
        h4: _state.h4,
        h5: _state.h5,
        h6: _state.h6,
        h7: _state.h7
      };
      _update(s2, _w, finalBlock);
      var rval = forge2.util.createBuffer();
      rval.putInt32(s2.h0);
      rval.putInt32(s2.h1);
      rval.putInt32(s2.h2);
      rval.putInt32(s2.h3);
      rval.putInt32(s2.h4);
      rval.putInt32(s2.h5);
      rval.putInt32(s2.h6);
      rval.putInt32(s2.h7);
      return rval;
    };
    return md2;
  };
  var _padding = null;
  var _initialized = false;
  var _k = null;
  function _init() {
    _padding = String.fromCharCode(128);
    _padding += forge2.util.fillString(String.fromCharCode(0), 64);
    _k = [
      1116352408,
      1899447441,
      3049323471,
      3921009573,
      961987163,
      1508970993,
      2453635748,
      2870763221,
      3624381080,
      310598401,
      607225278,
      1426881987,
      1925078388,
      2162078206,
      2614888103,
      3248222580,
      3835390401,
      4022224774,
      264347078,
      604807628,
      770255983,
      1249150122,
      1555081692,
      1996064986,
      2554220882,
      2821834349,
      2952996808,
      3210313671,
      3336571891,
      3584528711,
      113926993,
      338241895,
      666307205,
      773529912,
      1294757372,
      1396182291,
      1695183700,
      1986661051,
      2177026350,
      2456956037,
      2730485921,
      2820302411,
      3259730800,
      3345764771,
      3516065817,
      3600352804,
      4094571909,
      275423344,
      430227734,
      506948616,
      659060556,
      883997877,
      958139571,
      1322822218,
      1537002063,
      1747873779,
      1955562222,
      2024104815,
      2227730452,
      2361852424,
      2428436474,
      2756734187,
      3204031479,
      3329325298
    ];
    _initialized = true;
  }
  function _update(s, w, bytes) {
    var t1, t2, s0, s1, ch, maj, i, a, b, c, d, e, f, g, h;
    var len = bytes.length();
    while (len >= 64) {
      for (i = 0; i < 16; ++i) {
        w[i] = bytes.getInt32();
      }
      for (; i < 64; ++i) {
        t1 = w[i - 2];
        t1 = (t1 >>> 17 | t1 << 15) ^ (t1 >>> 19 | t1 << 13) ^ t1 >>> 10;
        t2 = w[i - 15];
        t2 = (t2 >>> 7 | t2 << 25) ^ (t2 >>> 18 | t2 << 14) ^ t2 >>> 3;
        w[i] = t1 + w[i - 7] + t2 + w[i - 16] | 0;
      }
      a = s.h0;
      b = s.h1;
      c = s.h2;
      d = s.h3;
      e = s.h4;
      f = s.h5;
      g = s.h6;
      h = s.h7;
      for (i = 0; i < 64; ++i) {
        s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
        ch = g ^ e & (f ^ g);
        s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
        maj = a & b | c & (a ^ b);
        t1 = h + s1 + ch + _k[i] + w[i];
        t2 = s0 + maj;
        h = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 >>> 0;
      }
      s.h0 = s.h0 + a | 0;
      s.h1 = s.h1 + b | 0;
      s.h2 = s.h2 + c | 0;
      s.h3 = s.h3 + d | 0;
      s.h4 = s.h4 + e | 0;
      s.h5 = s.h5 + f | 0;
      s.h6 = s.h6 + g | 0;
      s.h7 = s.h7 + h | 0;
      len -= 64;
    }
  }
  return sha256.exports;
}
var prng = { exports: {} };
var hasRequiredPrng;
function requirePrng() {
  if (hasRequiredPrng) return prng.exports;
  hasRequiredPrng = 1;
  var forge2 = requireForge();
  requireUtil();
  var _crypto = null;
  if (forge2.util.isNodejs && !forge2.options.usePureJavaScript && !process.versions["node-webkit"]) {
    _crypto = require$$3;
  }
  var prng$1 = prng.exports = forge2.prng = forge2.prng || {};
  prng$1.create = function(plugin) {
    var ctx = {
      plugin,
      key: null,
      seed: null,
      time: null,
      // number of reseeds so far
      reseeds: 0,
      // amount of data generated so far
      generated: 0,
      // no initial key bytes
      keyBytes: ""
    };
    var md2 = plugin.md;
    var pools = new Array(32);
    for (var i = 0; i < 32; ++i) {
      pools[i] = md2.create();
    }
    ctx.pools = pools;
    ctx.pool = 0;
    ctx.generate = function(count, callback) {
      if (!callback) {
        return ctx.generateSync(count);
      }
      var cipher2 = ctx.plugin.cipher;
      var increment = ctx.plugin.increment;
      var formatKey = ctx.plugin.formatKey;
      var formatSeed = ctx.plugin.formatSeed;
      var b = forge2.util.createBuffer();
      ctx.key = null;
      generate();
      function generate(err) {
        if (err) {
          return callback(err);
        }
        if (b.length() >= count) {
          return callback(null, b.getBytes(count));
        }
        if (ctx.generated > 1048575) {
          ctx.key = null;
        }
        if (ctx.key === null) {
          return forge2.util.nextTick(function() {
            _reseed(generate);
          });
        }
        var bytes = cipher2(ctx.key, ctx.seed);
        ctx.generated += bytes.length;
        b.putBytes(bytes);
        ctx.key = formatKey(cipher2(ctx.key, increment(ctx.seed)));
        ctx.seed = formatSeed(cipher2(ctx.key, ctx.seed));
        forge2.util.setImmediate(generate);
      }
    };
    ctx.generateSync = function(count) {
      var cipher2 = ctx.plugin.cipher;
      var increment = ctx.plugin.increment;
      var formatKey = ctx.plugin.formatKey;
      var formatSeed = ctx.plugin.formatSeed;
      ctx.key = null;
      var b = forge2.util.createBuffer();
      while (b.length() < count) {
        if (ctx.generated > 1048575) {
          ctx.key = null;
        }
        if (ctx.key === null) {
          _reseedSync();
        }
        var bytes = cipher2(ctx.key, ctx.seed);
        ctx.generated += bytes.length;
        b.putBytes(bytes);
        ctx.key = formatKey(cipher2(ctx.key, increment(ctx.seed)));
        ctx.seed = formatSeed(cipher2(ctx.key, ctx.seed));
      }
      return b.getBytes(count);
    };
    function _reseed(callback) {
      if (ctx.pools[0].messageLength >= 32) {
        _seed();
        return callback();
      }
      var needed = 32 - ctx.pools[0].messageLength << 5;
      ctx.seedFile(needed, function(err, bytes) {
        if (err) {
          return callback(err);
        }
        ctx.collect(bytes);
        _seed();
        callback();
      });
    }
    function _reseedSync() {
      if (ctx.pools[0].messageLength >= 32) {
        return _seed();
      }
      var needed = 32 - ctx.pools[0].messageLength << 5;
      ctx.collect(ctx.seedFileSync(needed));
      _seed();
    }
    function _seed() {
      ctx.reseeds = ctx.reseeds === 4294967295 ? 0 : ctx.reseeds + 1;
      var md3 = ctx.plugin.md.create();
      md3.update(ctx.keyBytes);
      var _2powK = 1;
      for (var k = 0; k < 32; ++k) {
        if (ctx.reseeds % _2powK === 0) {
          md3.update(ctx.pools[k].digest().getBytes());
          ctx.pools[k].start();
        }
        _2powK = _2powK << 1;
      }
      ctx.keyBytes = md3.digest().getBytes();
      md3.start();
      md3.update(ctx.keyBytes);
      var seedBytes = md3.digest().getBytes();
      ctx.key = ctx.plugin.formatKey(ctx.keyBytes);
      ctx.seed = ctx.plugin.formatSeed(seedBytes);
      ctx.generated = 0;
    }
    function defaultSeedFile(needed) {
      var getRandomValues = null;
      var globalScope = forge2.util.globalScope;
      var _crypto2 = globalScope.crypto || globalScope.msCrypto;
      if (_crypto2 && _crypto2.getRandomValues) {
        getRandomValues = function(arr) {
          return _crypto2.getRandomValues(arr);
        };
      }
      var b = forge2.util.createBuffer();
      if (getRandomValues) {
        while (b.length() < needed) {
          var count = Math.max(1, Math.min(needed - b.length(), 65536) / 4);
          var entropy = new Uint32Array(Math.floor(count));
          try {
            getRandomValues(entropy);
            for (var i2 = 0; i2 < entropy.length; ++i2) {
              b.putInt32(entropy[i2]);
            }
          } catch (e) {
            if (!(typeof QuotaExceededError !== "undefined" && e instanceof QuotaExceededError)) {
              throw e;
            }
          }
        }
      }
      if (b.length() < needed) {
        var hi, lo, next;
        var seed = Math.floor(Math.random() * 65536);
        while (b.length() < needed) {
          lo = 16807 * (seed & 65535);
          hi = 16807 * (seed >> 16);
          lo += (hi & 32767) << 16;
          lo += hi >> 15;
          lo = (lo & 2147483647) + (lo >> 31);
          seed = lo & 4294967295;
          for (var i2 = 0; i2 < 3; ++i2) {
            next = seed >>> (i2 << 3);
            next ^= Math.floor(Math.random() * 256);
            b.putByte(next & 255);
          }
        }
      }
      return b.getBytes(needed);
    }
    if (_crypto) {
      ctx.seedFile = function(needed, callback) {
        _crypto.randomBytes(needed, function(err, bytes) {
          if (err) {
            return callback(err);
          }
          callback(null, bytes.toString());
        });
      };
      ctx.seedFileSync = function(needed) {
        return _crypto.randomBytes(needed).toString();
      };
    } else {
      ctx.seedFile = function(needed, callback) {
        try {
          callback(null, defaultSeedFile(needed));
        } catch (e) {
          callback(e);
        }
      };
      ctx.seedFileSync = defaultSeedFile;
    }
    ctx.collect = function(bytes) {
      var count = bytes.length;
      for (var i2 = 0; i2 < count; ++i2) {
        ctx.pools[ctx.pool].update(bytes.substr(i2, 1));
        ctx.pool = ctx.pool === 31 ? 0 : ctx.pool + 1;
      }
    };
    ctx.collectInt = function(i2, n) {
      var bytes = "";
      for (var x = 0; x < n; x += 8) {
        bytes += String.fromCharCode(i2 >> x & 255);
      }
      ctx.collect(bytes);
    };
    ctx.registerWorker = function(worker) {
      if (worker === self) {
        ctx.seedFile = function(needed, callback) {
          function listener2(e) {
            var data = e.data;
            if (data.forge && data.forge.prng) {
              self.removeEventListener("message", listener2);
              callback(data.forge.prng.err, data.forge.prng.bytes);
            }
          }
          self.addEventListener("message", listener2);
          self.postMessage({ forge: { prng: { needed } } });
        };
      } else {
        var listener = function(e) {
          var data = e.data;
          if (data.forge && data.forge.prng) {
            ctx.seedFile(data.forge.prng.needed, function(err, bytes) {
              worker.postMessage({ forge: { prng: { err, bytes } } });
            });
          }
        };
        worker.addEventListener("message", listener);
      }
    };
    return ctx;
  };
  return prng.exports;
}
var hasRequiredRandom;
function requireRandom() {
  if (hasRequiredRandom) return random.exports;
  hasRequiredRandom = 1;
  var forge2 = requireForge();
  requireAes();
  requireSha256();
  requirePrng();
  requireUtil();
  (function() {
    if (forge2.random && forge2.random.getBytes) {
      random.exports = forge2.random;
      return;
    }
    (function(jQuery2) {
      var prng_aes = {};
      var _prng_aes_output = new Array(4);
      var _prng_aes_buffer = forge2.util.createBuffer();
      prng_aes.formatKey = function(key2) {
        var tmp = forge2.util.createBuffer(key2);
        key2 = new Array(4);
        key2[0] = tmp.getInt32();
        key2[1] = tmp.getInt32();
        key2[2] = tmp.getInt32();
        key2[3] = tmp.getInt32();
        return forge2.aes._expandKey(key2, false);
      };
      prng_aes.formatSeed = function(seed) {
        var tmp = forge2.util.createBuffer(seed);
        seed = new Array(4);
        seed[0] = tmp.getInt32();
        seed[1] = tmp.getInt32();
        seed[2] = tmp.getInt32();
        seed[3] = tmp.getInt32();
        return seed;
      };
      prng_aes.cipher = function(key2, seed) {
        forge2.aes._updateBlock(key2, seed, _prng_aes_output, false);
        _prng_aes_buffer.putInt32(_prng_aes_output[0]);
        _prng_aes_buffer.putInt32(_prng_aes_output[1]);
        _prng_aes_buffer.putInt32(_prng_aes_output[2]);
        _prng_aes_buffer.putInt32(_prng_aes_output[3]);
        return _prng_aes_buffer.getBytes();
      };
      prng_aes.increment = function(seed) {
        ++seed[3];
        return seed;
      };
      prng_aes.md = forge2.md.sha256;
      function spawnPrng() {
        var ctx = forge2.prng.create(prng_aes);
        ctx.getBytes = function(count, callback) {
          return ctx.generate(count, callback);
        };
        ctx.getBytesSync = function(count) {
          return ctx.generate(count);
        };
        return ctx;
      }
      var _ctx = spawnPrng();
      var getRandomValues = null;
      var globalScope = forge2.util.globalScope;
      var _crypto = globalScope.crypto || globalScope.msCrypto;
      if (_crypto && _crypto.getRandomValues) {
        getRandomValues = function(arr) {
          return _crypto.getRandomValues(arr);
        };
      }
      if (forge2.options.usePureJavaScript || !forge2.util.isNodejs && !getRandomValues) {
        _ctx.collectInt(+/* @__PURE__ */ new Date(), 32);
        if (typeof navigator !== "undefined") {
          var _navBytes = "";
          for (var key in navigator) {
            try {
              if (typeof navigator[key] == "string") {
                _navBytes += navigator[key];
              }
            } catch (e) {
            }
          }
          _ctx.collect(_navBytes);
          _navBytes = null;
        }
        if (jQuery2) {
          jQuery2().mousemove(function(e) {
            _ctx.collectInt(e.clientX, 16);
            _ctx.collectInt(e.clientY, 16);
          });
          jQuery2().keypress(function(e) {
            _ctx.collectInt(e.charCode, 8);
          });
        }
      }
      if (!forge2.random) {
        forge2.random = _ctx;
      } else {
        for (var key in _ctx) {
          forge2.random[key] = _ctx[key];
        }
      }
      forge2.random.createInstance = spawnPrng;
      random.exports = forge2.random;
    })(typeof jQuery !== "undefined" ? jQuery : null);
  })();
  return random.exports;
}
var rc2;
var hasRequiredRc2;
function requireRc2() {
  if (hasRequiredRc2) return rc2;
  hasRequiredRc2 = 1;
  var forge2 = requireForge();
  requireUtil();
  var piTable = [
    217,
    120,
    249,
    196,
    25,
    221,
    181,
    237,
    40,
    233,
    253,
    121,
    74,
    160,
    216,
    157,
    198,
    126,
    55,
    131,
    43,
    118,
    83,
    142,
    98,
    76,
    100,
    136,
    68,
    139,
    251,
    162,
    23,
    154,
    89,
    245,
    135,
    179,
    79,
    19,
    97,
    69,
    109,
    141,
    9,
    129,
    125,
    50,
    189,
    143,
    64,
    235,
    134,
    183,
    123,
    11,
    240,
    149,
    33,
    34,
    92,
    107,
    78,
    130,
    84,
    214,
    101,
    147,
    206,
    96,
    178,
    28,
    115,
    86,
    192,
    20,
    167,
    140,
    241,
    220,
    18,
    117,
    202,
    31,
    59,
    190,
    228,
    209,
    66,
    61,
    212,
    48,
    163,
    60,
    182,
    38,
    111,
    191,
    14,
    218,
    70,
    105,
    7,
    87,
    39,
    242,
    29,
    155,
    188,
    148,
    67,
    3,
    248,
    17,
    199,
    246,
    144,
    239,
    62,
    231,
    6,
    195,
    213,
    47,
    200,
    102,
    30,
    215,
    8,
    232,
    234,
    222,
    128,
    82,
    238,
    247,
    132,
    170,
    114,
    172,
    53,
    77,
    106,
    42,
    150,
    26,
    210,
    113,
    90,
    21,
    73,
    116,
    75,
    159,
    208,
    94,
    4,
    24,
    164,
    236,
    194,
    224,
    65,
    110,
    15,
    81,
    203,
    204,
    36,
    145,
    175,
    80,
    161,
    244,
    112,
    57,
    153,
    124,
    58,
    133,
    35,
    184,
    180,
    122,
    252,
    2,
    54,
    91,
    37,
    85,
    151,
    49,
    45,
    93,
    250,
    152,
    227,
    138,
    146,
    174,
    5,
    223,
    41,
    16,
    103,
    108,
    186,
    201,
    211,
    0,
    230,
    207,
    225,
    158,
    168,
    44,
    99,
    22,
    1,
    63,
    88,
    226,
    137,
    169,
    13,
    56,
    52,
    27,
    171,
    51,
    255,
    176,
    187,
    72,
    12,
    95,
    185,
    177,
    205,
    46,
    197,
    243,
    219,
    71,
    229,
    165,
    156,
    119,
    10,
    166,
    32,
    104,
    254,
    127,
    193,
    173
  ];
  var s = [1, 2, 3, 5];
  var rol = function(word, bits) {
    return word << bits & 65535 | (word & 65535) >> 16 - bits;
  };
  var ror = function(word, bits) {
    return (word & 65535) >> bits | word << 16 - bits & 65535;
  };
  rc2 = forge2.rc2 = forge2.rc2 || {};
  forge2.rc2.expandKey = function(key, effKeyBits) {
    if (typeof key === "string") {
      key = forge2.util.createBuffer(key);
    }
    effKeyBits = effKeyBits || 128;
    var L = key;
    var T = key.length();
    var T1 = effKeyBits;
    var T8 = Math.ceil(T1 / 8);
    var TM = 255 >> (T1 & 7);
    var i;
    for (i = T; i < 128; i++) {
      L.putByte(piTable[L.at(i - 1) + L.at(i - T) & 255]);
    }
    L.setAt(128 - T8, piTable[L.at(128 - T8) & TM]);
    for (i = 127 - T8; i >= 0; i--) {
      L.setAt(i, piTable[L.at(i + 1) ^ L.at(i + T8)]);
    }
    return L;
  };
  var createCipher = function(key, bits, encrypt) {
    var _finish = false, _input = null, _output = null, _iv = null;
    var mixRound, mashRound;
    var i, j, K = [];
    key = forge2.rc2.expandKey(key, bits);
    for (i = 0; i < 64; i++) {
      K.push(key.getInt16Le());
    }
    if (encrypt) {
      mixRound = function(R) {
        for (i = 0; i < 4; i++) {
          R[i] += K[j] + (R[(i + 3) % 4] & R[(i + 2) % 4]) + (~R[(i + 3) % 4] & R[(i + 1) % 4]);
          R[i] = rol(R[i], s[i]);
          j++;
        }
      };
      mashRound = function(R) {
        for (i = 0; i < 4; i++) {
          R[i] += K[R[(i + 3) % 4] & 63];
        }
      };
    } else {
      mixRound = function(R) {
        for (i = 3; i >= 0; i--) {
          R[i] = ror(R[i], s[i]);
          R[i] -= K[j] + (R[(i + 3) % 4] & R[(i + 2) % 4]) + (~R[(i + 3) % 4] & R[(i + 1) % 4]);
          j--;
        }
      };
      mashRound = function(R) {
        for (i = 3; i >= 0; i--) {
          R[i] -= K[R[(i + 3) % 4] & 63];
        }
      };
    }
    var runPlan = function(plan) {
      var R = [];
      for (i = 0; i < 4; i++) {
        var val = _input.getInt16Le();
        if (_iv !== null) {
          if (encrypt) {
            val ^= _iv.getInt16Le();
          } else {
            _iv.putInt16Le(val);
          }
        }
        R.push(val & 65535);
      }
      j = encrypt ? 0 : 63;
      for (var ptr = 0; ptr < plan.length; ptr++) {
        for (var ctr = 0; ctr < plan[ptr][0]; ctr++) {
          plan[ptr][1](R);
        }
      }
      for (i = 0; i < 4; i++) {
        if (_iv !== null) {
          if (encrypt) {
            _iv.putInt16Le(R[i]);
          } else {
            R[i] ^= _iv.getInt16Le();
          }
        }
        _output.putInt16Le(R[i]);
      }
    };
    var cipher2 = null;
    cipher2 = {
      /**
       * Starts or restarts the encryption or decryption process, whichever
       * was previously configured.
       *
       * To use the cipher in CBC mode, iv may be given either as a string
       * of bytes, or as a byte buffer.  For ECB mode, give null as iv.
       *
       * @param iv the initialization vector to use, null for ECB mode.
       * @param output the output the buffer to write to, null to create one.
       */
      start: function(iv, output) {
        if (iv) {
          if (typeof iv === "string") {
            iv = forge2.util.createBuffer(iv);
          }
        }
        _finish = false;
        _input = forge2.util.createBuffer();
        _output = output || new forge2.util.createBuffer();
        _iv = iv;
        cipher2.output = _output;
      },
      /**
       * Updates the next block.
       *
       * @param input the buffer to read from.
       */
      update: function(input) {
        if (!_finish) {
          _input.putBuffer(input);
        }
        while (_input.length() >= 8) {
          runPlan([
            [5, mixRound],
            [1, mashRound],
            [6, mixRound],
            [1, mashRound],
            [5, mixRound]
          ]);
        }
      },
      /**
       * Finishes encrypting or decrypting.
       *
       * @param pad a padding function to use, null for PKCS#7 padding,
       *           signature(blockSize, buffer, decrypt).
       *
       * @return true if successful, false on error.
       */
      finish: function(pad) {
        var rval = true;
        if (encrypt) {
          if (pad) {
            rval = pad(8, _input, !encrypt);
          } else {
            var padding = _input.length() === 8 ? 8 : 8 - _input.length();
            _input.fillWithByte(padding, padding);
          }
        }
        if (rval) {
          _finish = true;
          cipher2.update();
        }
        if (!encrypt) {
          rval = _input.length() === 0;
          if (rval) {
            if (pad) {
              rval = pad(8, _output, !encrypt);
            } else {
              var len = _output.length();
              var count = _output.at(len - 1);
              if (count > len) {
                rval = false;
              } else {
                _output.truncate(count);
              }
            }
          }
        }
        return rval;
      }
    };
    return cipher2;
  };
  forge2.rc2.startEncrypting = function(key, iv, output) {
    var cipher2 = forge2.rc2.createEncryptionCipher(key, 128);
    cipher2.start(iv, output);
    return cipher2;
  };
  forge2.rc2.createEncryptionCipher = function(key, bits) {
    return createCipher(key, bits, true);
  };
  forge2.rc2.startDecrypting = function(key, iv, output) {
    var cipher2 = forge2.rc2.createDecryptionCipher(key, 128);
    cipher2.start(iv, output);
    return cipher2;
  };
  forge2.rc2.createDecryptionCipher = function(key, bits) {
    return createCipher(key, bits, false);
  };
  return rc2;
}
var jsbn;
var hasRequiredJsbn;
function requireJsbn() {
  if (hasRequiredJsbn) return jsbn;
  hasRequiredJsbn = 1;
  var forge2 = requireForge();
  jsbn = forge2.jsbn = forge2.jsbn || {};
  var dbits;
  function BigInteger(a, b, c) {
    this.data = [];
    if (a != null)
      if ("number" == typeof a) this.fromNumber(a, b, c);
      else if (b == null && "string" != typeof a) this.fromString(a, 256);
      else this.fromString(a, b);
  }
  forge2.jsbn.BigInteger = BigInteger;
  function nbi() {
    return new BigInteger(null);
  }
  function am1(i, x, w, j, c, n) {
    while (--n >= 0) {
      var v = x * this.data[i++] + w.data[j] + c;
      c = Math.floor(v / 67108864);
      w.data[j++] = v & 67108863;
    }
    return c;
  }
  function am2(i, x, w, j, c, n) {
    var xl = x & 32767, xh = x >> 15;
    while (--n >= 0) {
      var l = this.data[i] & 32767;
      var h = this.data[i++] >> 15;
      var m = xh * l + h * xl;
      l = xl * l + ((m & 32767) << 15) + w.data[j] + (c & 1073741823);
      c = (l >>> 30) + (m >>> 15) + xh * h + (c >>> 30);
      w.data[j++] = l & 1073741823;
    }
    return c;
  }
  function am3(i, x, w, j, c, n) {
    var xl = x & 16383, xh = x >> 14;
    while (--n >= 0) {
      var l = this.data[i] & 16383;
      var h = this.data[i++] >> 14;
      var m = xh * l + h * xl;
      l = xl * l + ((m & 16383) << 14) + w.data[j] + c;
      c = (l >> 28) + (m >> 14) + xh * h;
      w.data[j++] = l & 268435455;
    }
    return c;
  }
  if (typeof navigator === "undefined") {
    BigInteger.prototype.am = am3;
    dbits = 28;
  } else if (navigator.appName == "Microsoft Internet Explorer") {
    BigInteger.prototype.am = am2;
    dbits = 30;
  } else if (navigator.appName != "Netscape") {
    BigInteger.prototype.am = am1;
    dbits = 26;
  } else {
    BigInteger.prototype.am = am3;
    dbits = 28;
  }
  BigInteger.prototype.DB = dbits;
  BigInteger.prototype.DM = (1 << dbits) - 1;
  BigInteger.prototype.DV = 1 << dbits;
  var BI_FP = 52;
  BigInteger.prototype.FV = Math.pow(2, BI_FP);
  BigInteger.prototype.F1 = BI_FP - dbits;
  BigInteger.prototype.F2 = 2 * dbits - BI_FP;
  var BI_RM = "0123456789abcdefghijklmnopqrstuvwxyz";
  var BI_RC = new Array();
  var rr, vv;
  rr = "0".charCodeAt(0);
  for (vv = 0; vv <= 9; ++vv) BI_RC[rr++] = vv;
  rr = "a".charCodeAt(0);
  for (vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;
  rr = "A".charCodeAt(0);
  for (vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;
  function int2char(n) {
    return BI_RM.charAt(n);
  }
  function intAt(s, i) {
    var c = BI_RC[s.charCodeAt(i)];
    return c == null ? -1 : c;
  }
  function bnpCopyTo(r) {
    for (var i = this.t - 1; i >= 0; --i) r.data[i] = this.data[i];
    r.t = this.t;
    r.s = this.s;
  }
  function bnpFromInt(x) {
    this.t = 1;
    this.s = x < 0 ? -1 : 0;
    if (x > 0) this.data[0] = x;
    else if (x < -1) this.data[0] = x + this.DV;
    else this.t = 0;
  }
  function nbv(i) {
    var r = nbi();
    r.fromInt(i);
    return r;
  }
  function bnpFromString(s, b) {
    var k;
    if (b == 16) k = 4;
    else if (b == 8) k = 3;
    else if (b == 256) k = 8;
    else if (b == 2) k = 1;
    else if (b == 32) k = 5;
    else if (b == 4) k = 2;
    else {
      this.fromRadix(s, b);
      return;
    }
    this.t = 0;
    this.s = 0;
    var i = s.length, mi = false, sh = 0;
    while (--i >= 0) {
      var x = k == 8 ? s[i] & 255 : intAt(s, i);
      if (x < 0) {
        if (s.charAt(i) == "-") mi = true;
        continue;
      }
      mi = false;
      if (sh == 0)
        this.data[this.t++] = x;
      else if (sh + k > this.DB) {
        this.data[this.t - 1] |= (x & (1 << this.DB - sh) - 1) << sh;
        this.data[this.t++] = x >> this.DB - sh;
      } else
        this.data[this.t - 1] |= x << sh;
      sh += k;
      if (sh >= this.DB) sh -= this.DB;
    }
    if (k == 8 && (s[0] & 128) != 0) {
      this.s = -1;
      if (sh > 0) this.data[this.t - 1] |= (1 << this.DB - sh) - 1 << sh;
    }
    this.clamp();
    if (mi) BigInteger.ZERO.subTo(this, this);
  }
  function bnpClamp() {
    var c = this.s & this.DM;
    while (this.t > 0 && this.data[this.t - 1] == c) --this.t;
  }
  function bnToString(b) {
    if (this.s < 0) return "-" + this.negate().toString(b);
    var k;
    if (b == 16) k = 4;
    else if (b == 8) k = 3;
    else if (b == 2) k = 1;
    else if (b == 32) k = 5;
    else if (b == 4) k = 2;
    else return this.toRadix(b);
    var km = (1 << k) - 1, d, m = false, r = "", i = this.t;
    var p = this.DB - i * this.DB % k;
    if (i-- > 0) {
      if (p < this.DB && (d = this.data[i] >> p) > 0) {
        m = true;
        r = int2char(d);
      }
      while (i >= 0) {
        if (p < k) {
          d = (this.data[i] & (1 << p) - 1) << k - p;
          d |= this.data[--i] >> (p += this.DB - k);
        } else {
          d = this.data[i] >> (p -= k) & km;
          if (p <= 0) {
            p += this.DB;
            --i;
          }
        }
        if (d > 0) m = true;
        if (m) r += int2char(d);
      }
    }
    return m ? r : "0";
  }
  function bnNegate() {
    var r = nbi();
    BigInteger.ZERO.subTo(this, r);
    return r;
  }
  function bnAbs() {
    return this.s < 0 ? this.negate() : this;
  }
  function bnCompareTo(a) {
    var r = this.s - a.s;
    if (r != 0) return r;
    var i = this.t;
    r = i - a.t;
    if (r != 0) return this.s < 0 ? -r : r;
    while (--i >= 0) if ((r = this.data[i] - a.data[i]) != 0) return r;
    return 0;
  }
  function nbits(x) {
    var r = 1, t;
    if ((t = x >>> 16) != 0) {
      x = t;
      r += 16;
    }
    if ((t = x >> 8) != 0) {
      x = t;
      r += 8;
    }
    if ((t = x >> 4) != 0) {
      x = t;
      r += 4;
    }
    if ((t = x >> 2) != 0) {
      x = t;
      r += 2;
    }
    if ((t = x >> 1) != 0) {
      x = t;
      r += 1;
    }
    return r;
  }
  function bnBitLength() {
    if (this.t <= 0) return 0;
    return this.DB * (this.t - 1) + nbits(this.data[this.t - 1] ^ this.s & this.DM);
  }
  function bnpDLShiftTo(n, r) {
    var i;
    for (i = this.t - 1; i >= 0; --i) r.data[i + n] = this.data[i];
    for (i = n - 1; i >= 0; --i) r.data[i] = 0;
    r.t = this.t + n;
    r.s = this.s;
  }
  function bnpDRShiftTo(n, r) {
    for (var i = n; i < this.t; ++i) r.data[i - n] = this.data[i];
    r.t = Math.max(this.t - n, 0);
    r.s = this.s;
  }
  function bnpLShiftTo(n, r) {
    var bs = n % this.DB;
    var cbs = this.DB - bs;
    var bm = (1 << cbs) - 1;
    var ds = Math.floor(n / this.DB), c = this.s << bs & this.DM, i;
    for (i = this.t - 1; i >= 0; --i) {
      r.data[i + ds + 1] = this.data[i] >> cbs | c;
      c = (this.data[i] & bm) << bs;
    }
    for (i = ds - 1; i >= 0; --i) r.data[i] = 0;
    r.data[ds] = c;
    r.t = this.t + ds + 1;
    r.s = this.s;
    r.clamp();
  }
  function bnpRShiftTo(n, r) {
    r.s = this.s;
    var ds = Math.floor(n / this.DB);
    if (ds >= this.t) {
      r.t = 0;
      return;
    }
    var bs = n % this.DB;
    var cbs = this.DB - bs;
    var bm = (1 << bs) - 1;
    r.data[0] = this.data[ds] >> bs;
    for (var i = ds + 1; i < this.t; ++i) {
      r.data[i - ds - 1] |= (this.data[i] & bm) << cbs;
      r.data[i - ds] = this.data[i] >> bs;
    }
    if (bs > 0) r.data[this.t - ds - 1] |= (this.s & bm) << cbs;
    r.t = this.t - ds;
    r.clamp();
  }
  function bnpSubTo(a, r) {
    var i = 0, c = 0, m = Math.min(a.t, this.t);
    while (i < m) {
      c += this.data[i] - a.data[i];
      r.data[i++] = c & this.DM;
      c >>= this.DB;
    }
    if (a.t < this.t) {
      c -= a.s;
      while (i < this.t) {
        c += this.data[i];
        r.data[i++] = c & this.DM;
        c >>= this.DB;
      }
      c += this.s;
    } else {
      c += this.s;
      while (i < a.t) {
        c -= a.data[i];
        r.data[i++] = c & this.DM;
        c >>= this.DB;
      }
      c -= a.s;
    }
    r.s = c < 0 ? -1 : 0;
    if (c < -1) r.data[i++] = this.DV + c;
    else if (c > 0) r.data[i++] = c;
    r.t = i;
    r.clamp();
  }
  function bnpMultiplyTo(a, r) {
    var x = this.abs(), y = a.abs();
    var i = x.t;
    r.t = i + y.t;
    while (--i >= 0) r.data[i] = 0;
    for (i = 0; i < y.t; ++i) r.data[i + x.t] = x.am(0, y.data[i], r, i, 0, x.t);
    r.s = 0;
    r.clamp();
    if (this.s != a.s) BigInteger.ZERO.subTo(r, r);
  }
  function bnpSquareTo(r) {
    var x = this.abs();
    var i = r.t = 2 * x.t;
    while (--i >= 0) r.data[i] = 0;
    for (i = 0; i < x.t - 1; ++i) {
      var c = x.am(i, x.data[i], r, 2 * i, 0, 1);
      if ((r.data[i + x.t] += x.am(i + 1, 2 * x.data[i], r, 2 * i + 1, c, x.t - i - 1)) >= x.DV) {
        r.data[i + x.t] -= x.DV;
        r.data[i + x.t + 1] = 1;
      }
    }
    if (r.t > 0) r.data[r.t - 1] += x.am(i, x.data[i], r, 2 * i, 0, 1);
    r.s = 0;
    r.clamp();
  }
  function bnpDivRemTo(m, q, r) {
    var pm = m.abs();
    if (pm.t <= 0) return;
    var pt = this.abs();
    if (pt.t < pm.t) {
      if (q != null) q.fromInt(0);
      if (r != null) this.copyTo(r);
      return;
    }
    if (r == null) r = nbi();
    var y = nbi(), ts = this.s, ms2 = m.s;
    var nsh = this.DB - nbits(pm.data[pm.t - 1]);
    if (nsh > 0) {
      pm.lShiftTo(nsh, y);
      pt.lShiftTo(nsh, r);
    } else {
      pm.copyTo(y);
      pt.copyTo(r);
    }
    var ys = y.t;
    var y0 = y.data[ys - 1];
    if (y0 == 0) return;
    var yt = y0 * (1 << this.F1) + (ys > 1 ? y.data[ys - 2] >> this.F2 : 0);
    var d1 = this.FV / yt, d2 = (1 << this.F1) / yt, e = 1 << this.F2;
    var i = r.t, j = i - ys, t = q == null ? nbi() : q;
    y.dlShiftTo(j, t);
    if (r.compareTo(t) >= 0) {
      r.data[r.t++] = 1;
      r.subTo(t, r);
    }
    BigInteger.ONE.dlShiftTo(ys, t);
    t.subTo(y, y);
    while (y.t < ys) y.data[y.t++] = 0;
    while (--j >= 0) {
      var qd = r.data[--i] == y0 ? this.DM : Math.floor(r.data[i] * d1 + (r.data[i - 1] + e) * d2);
      if ((r.data[i] += y.am(0, qd, r, j, 0, ys)) < qd) {
        y.dlShiftTo(j, t);
        r.subTo(t, r);
        while (r.data[i] < --qd) r.subTo(t, r);
      }
    }
    if (q != null) {
      r.drShiftTo(ys, q);
      if (ts != ms2) BigInteger.ZERO.subTo(q, q);
    }
    r.t = ys;
    r.clamp();
    if (nsh > 0) r.rShiftTo(nsh, r);
    if (ts < 0) BigInteger.ZERO.subTo(r, r);
  }
  function bnMod(a) {
    var r = nbi();
    this.abs().divRemTo(a, null, r);
    if (this.s < 0 && r.compareTo(BigInteger.ZERO) > 0) a.subTo(r, r);
    return r;
  }
  function Classic(m) {
    this.m = m;
  }
  function cConvert(x) {
    if (x.s < 0 || x.compareTo(this.m) >= 0) return x.mod(this.m);
    else return x;
  }
  function cRevert(x) {
    return x;
  }
  function cReduce(x) {
    x.divRemTo(this.m, null, x);
  }
  function cMulTo(x, y, r) {
    x.multiplyTo(y, r);
    this.reduce(r);
  }
  function cSqrTo(x, r) {
    x.squareTo(r);
    this.reduce(r);
  }
  Classic.prototype.convert = cConvert;
  Classic.prototype.revert = cRevert;
  Classic.prototype.reduce = cReduce;
  Classic.prototype.mulTo = cMulTo;
  Classic.prototype.sqrTo = cSqrTo;
  function bnpInvDigit() {
    if (this.t < 1) return 0;
    var x = this.data[0];
    if ((x & 1) == 0) return 0;
    var y = x & 3;
    y = y * (2 - (x & 15) * y) & 15;
    y = y * (2 - (x & 255) * y) & 255;
    y = y * (2 - ((x & 65535) * y & 65535)) & 65535;
    y = y * (2 - x * y % this.DV) % this.DV;
    return y > 0 ? this.DV - y : -y;
  }
  function Montgomery(m) {
    this.m = m;
    this.mp = m.invDigit();
    this.mpl = this.mp & 32767;
    this.mph = this.mp >> 15;
    this.um = (1 << m.DB - 15) - 1;
    this.mt2 = 2 * m.t;
  }
  function montConvert(x) {
    var r = nbi();
    x.abs().dlShiftTo(this.m.t, r);
    r.divRemTo(this.m, null, r);
    if (x.s < 0 && r.compareTo(BigInteger.ZERO) > 0) this.m.subTo(r, r);
    return r;
  }
  function montRevert(x) {
    var r = nbi();
    x.copyTo(r);
    this.reduce(r);
    return r;
  }
  function montReduce(x) {
    while (x.t <= this.mt2)
      x.data[x.t++] = 0;
    for (var i = 0; i < this.m.t; ++i) {
      var j = x.data[i] & 32767;
      var u0 = j * this.mpl + ((j * this.mph + (x.data[i] >> 15) * this.mpl & this.um) << 15) & x.DM;
      j = i + this.m.t;
      x.data[j] += this.m.am(0, u0, x, i, 0, this.m.t);
      while (x.data[j] >= x.DV) {
        x.data[j] -= x.DV;
        x.data[++j]++;
      }
    }
    x.clamp();
    x.drShiftTo(this.m.t, x);
    if (x.compareTo(this.m) >= 0) x.subTo(this.m, x);
  }
  function montSqrTo(x, r) {
    x.squareTo(r);
    this.reduce(r);
  }
  function montMulTo(x, y, r) {
    x.multiplyTo(y, r);
    this.reduce(r);
  }
  Montgomery.prototype.convert = montConvert;
  Montgomery.prototype.revert = montRevert;
  Montgomery.prototype.reduce = montReduce;
  Montgomery.prototype.mulTo = montMulTo;
  Montgomery.prototype.sqrTo = montSqrTo;
  function bnpIsEven() {
    return (this.t > 0 ? this.data[0] & 1 : this.s) == 0;
  }
  function bnpExp(e, z) {
    if (e > 4294967295 || e < 1) return BigInteger.ONE;
    var r = nbi(), r2 = nbi(), g = z.convert(this), i = nbits(e) - 1;
    g.copyTo(r);
    while (--i >= 0) {
      z.sqrTo(r, r2);
      if ((e & 1 << i) > 0) z.mulTo(r2, g, r);
      else {
        var t = r;
        r = r2;
        r2 = t;
      }
    }
    return z.revert(r);
  }
  function bnModPowInt(e, m) {
    var z;
    if (e < 256 || m.isEven()) z = new Classic(m);
    else z = new Montgomery(m);
    return this.exp(e, z);
  }
  BigInteger.prototype.copyTo = bnpCopyTo;
  BigInteger.prototype.fromInt = bnpFromInt;
  BigInteger.prototype.fromString = bnpFromString;
  BigInteger.prototype.clamp = bnpClamp;
  BigInteger.prototype.dlShiftTo = bnpDLShiftTo;
  BigInteger.prototype.drShiftTo = bnpDRShiftTo;
  BigInteger.prototype.lShiftTo = bnpLShiftTo;
  BigInteger.prototype.rShiftTo = bnpRShiftTo;
  BigInteger.prototype.subTo = bnpSubTo;
  BigInteger.prototype.multiplyTo = bnpMultiplyTo;
  BigInteger.prototype.squareTo = bnpSquareTo;
  BigInteger.prototype.divRemTo = bnpDivRemTo;
  BigInteger.prototype.invDigit = bnpInvDigit;
  BigInteger.prototype.isEven = bnpIsEven;
  BigInteger.prototype.exp = bnpExp;
  BigInteger.prototype.toString = bnToString;
  BigInteger.prototype.negate = bnNegate;
  BigInteger.prototype.abs = bnAbs;
  BigInteger.prototype.compareTo = bnCompareTo;
  BigInteger.prototype.bitLength = bnBitLength;
  BigInteger.prototype.mod = bnMod;
  BigInteger.prototype.modPowInt = bnModPowInt;
  BigInteger.ZERO = nbv(0);
  BigInteger.ONE = nbv(1);
  function bnClone() {
    var r = nbi();
    this.copyTo(r);
    return r;
  }
  function bnIntValue() {
    if (this.s < 0) {
      if (this.t == 1) return this.data[0] - this.DV;
      else if (this.t == 0) return -1;
    } else if (this.t == 1) return this.data[0];
    else if (this.t == 0) return 0;
    return (this.data[1] & (1 << 32 - this.DB) - 1) << this.DB | this.data[0];
  }
  function bnByteValue() {
    return this.t == 0 ? this.s : this.data[0] << 24 >> 24;
  }
  function bnShortValue() {
    return this.t == 0 ? this.s : this.data[0] << 16 >> 16;
  }
  function bnpChunkSize(r) {
    return Math.floor(Math.LN2 * this.DB / Math.log(r));
  }
  function bnSigNum() {
    if (this.s < 0) return -1;
    else if (this.t <= 0 || this.t == 1 && this.data[0] <= 0) return 0;
    else return 1;
  }
  function bnpToRadix(b) {
    if (b == null) b = 10;
    if (this.signum() == 0 || b < 2 || b > 36) return "0";
    var cs = this.chunkSize(b);
    var a = Math.pow(b, cs);
    var d = nbv(a), y = nbi(), z = nbi(), r = "";
    this.divRemTo(d, y, z);
    while (y.signum() > 0) {
      r = (a + z.intValue()).toString(b).substr(1) + r;
      y.divRemTo(d, y, z);
    }
    return z.intValue().toString(b) + r;
  }
  function bnpFromRadix(s, b) {
    this.fromInt(0);
    if (b == null) b = 10;
    var cs = this.chunkSize(b);
    var d = Math.pow(b, cs), mi = false, j = 0, w = 0;
    for (var i = 0; i < s.length; ++i) {
      var x = intAt(s, i);
      if (x < 0) {
        if (s.charAt(i) == "-" && this.signum() == 0) mi = true;
        continue;
      }
      w = b * w + x;
      if (++j >= cs) {
        this.dMultiply(d);
        this.dAddOffset(w, 0);
        j = 0;
        w = 0;
      }
    }
    if (j > 0) {
      this.dMultiply(Math.pow(b, j));
      this.dAddOffset(w, 0);
    }
    if (mi) BigInteger.ZERO.subTo(this, this);
  }
  function bnpFromNumber(a, b, c) {
    if ("number" == typeof b) {
      if (a < 2) this.fromInt(1);
      else {
        this.fromNumber(a, c);
        if (!this.testBit(a - 1))
          this.bitwiseTo(BigInteger.ONE.shiftLeft(a - 1), op_or, this);
        if (this.isEven()) this.dAddOffset(1, 0);
        while (!this.isProbablePrime(b)) {
          this.dAddOffset(2, 0);
          if (this.bitLength() > a) this.subTo(BigInteger.ONE.shiftLeft(a - 1), this);
        }
      }
    } else {
      var x = new Array(), t = a & 7;
      x.length = (a >> 3) + 1;
      b.nextBytes(x);
      if (t > 0) x[0] &= (1 << t) - 1;
      else x[0] = 0;
      this.fromString(x, 256);
    }
  }
  function bnToByteArray() {
    var i = this.t, r = new Array();
    r[0] = this.s;
    var p = this.DB - i * this.DB % 8, d, k = 0;
    if (i-- > 0) {
      if (p < this.DB && (d = this.data[i] >> p) != (this.s & this.DM) >> p)
        r[k++] = d | this.s << this.DB - p;
      while (i >= 0) {
        if (p < 8) {
          d = (this.data[i] & (1 << p) - 1) << 8 - p;
          d |= this.data[--i] >> (p += this.DB - 8);
        } else {
          d = this.data[i] >> (p -= 8) & 255;
          if (p <= 0) {
            p += this.DB;
            --i;
          }
        }
        if ((d & 128) != 0) d |= -256;
        if (k == 0 && (this.s & 128) != (d & 128)) ++k;
        if (k > 0 || d != this.s) r[k++] = d;
      }
    }
    return r;
  }
  function bnEquals(a) {
    return this.compareTo(a) == 0;
  }
  function bnMin(a) {
    return this.compareTo(a) < 0 ? this : a;
  }
  function bnMax(a) {
    return this.compareTo(a) > 0 ? this : a;
  }
  function bnpBitwiseTo(a, op, r) {
    var i, f, m = Math.min(a.t, this.t);
    for (i = 0; i < m; ++i) r.data[i] = op(this.data[i], a.data[i]);
    if (a.t < this.t) {
      f = a.s & this.DM;
      for (i = m; i < this.t; ++i) r.data[i] = op(this.data[i], f);
      r.t = this.t;
    } else {
      f = this.s & this.DM;
      for (i = m; i < a.t; ++i) r.data[i] = op(f, a.data[i]);
      r.t = a.t;
    }
    r.s = op(this.s, a.s);
    r.clamp();
  }
  function op_and(x, y) {
    return x & y;
  }
  function bnAnd(a) {
    var r = nbi();
    this.bitwiseTo(a, op_and, r);
    return r;
  }
  function op_or(x, y) {
    return x | y;
  }
  function bnOr(a) {
    var r = nbi();
    this.bitwiseTo(a, op_or, r);
    return r;
  }
  function op_xor(x, y) {
    return x ^ y;
  }
  function bnXor(a) {
    var r = nbi();
    this.bitwiseTo(a, op_xor, r);
    return r;
  }
  function op_andnot(x, y) {
    return x & ~y;
  }
  function bnAndNot(a) {
    var r = nbi();
    this.bitwiseTo(a, op_andnot, r);
    return r;
  }
  function bnNot() {
    var r = nbi();
    for (var i = 0; i < this.t; ++i) r.data[i] = this.DM & ~this.data[i];
    r.t = this.t;
    r.s = ~this.s;
    return r;
  }
  function bnShiftLeft(n) {
    var r = nbi();
    if (n < 0) this.rShiftTo(-n, r);
    else this.lShiftTo(n, r);
    return r;
  }
  function bnShiftRight(n) {
    var r = nbi();
    if (n < 0) this.lShiftTo(-n, r);
    else this.rShiftTo(n, r);
    return r;
  }
  function lbit(x) {
    if (x == 0) return -1;
    var r = 0;
    if ((x & 65535) == 0) {
      x >>= 16;
      r += 16;
    }
    if ((x & 255) == 0) {
      x >>= 8;
      r += 8;
    }
    if ((x & 15) == 0) {
      x >>= 4;
      r += 4;
    }
    if ((x & 3) == 0) {
      x >>= 2;
      r += 2;
    }
    if ((x & 1) == 0) ++r;
    return r;
  }
  function bnGetLowestSetBit() {
    for (var i = 0; i < this.t; ++i)
      if (this.data[i] != 0) return i * this.DB + lbit(this.data[i]);
    if (this.s < 0) return this.t * this.DB;
    return -1;
  }
  function cbit(x) {
    var r = 0;
    while (x != 0) {
      x &= x - 1;
      ++r;
    }
    return r;
  }
  function bnBitCount() {
    var r = 0, x = this.s & this.DM;
    for (var i = 0; i < this.t; ++i) r += cbit(this.data[i] ^ x);
    return r;
  }
  function bnTestBit(n) {
    var j = Math.floor(n / this.DB);
    if (j >= this.t) return this.s != 0;
    return (this.data[j] & 1 << n % this.DB) != 0;
  }
  function bnpChangeBit(n, op) {
    var r = BigInteger.ONE.shiftLeft(n);
    this.bitwiseTo(r, op, r);
    return r;
  }
  function bnSetBit(n) {
    return this.changeBit(n, op_or);
  }
  function bnClearBit(n) {
    return this.changeBit(n, op_andnot);
  }
  function bnFlipBit(n) {
    return this.changeBit(n, op_xor);
  }
  function bnpAddTo(a, r) {
    var i = 0, c = 0, m = Math.min(a.t, this.t);
    while (i < m) {
      c += this.data[i] + a.data[i];
      r.data[i++] = c & this.DM;
      c >>= this.DB;
    }
    if (a.t < this.t) {
      c += a.s;
      while (i < this.t) {
        c += this.data[i];
        r.data[i++] = c & this.DM;
        c >>= this.DB;
      }
      c += this.s;
    } else {
      c += this.s;
      while (i < a.t) {
        c += a.data[i];
        r.data[i++] = c & this.DM;
        c >>= this.DB;
      }
      c += a.s;
    }
    r.s = c < 0 ? -1 : 0;
    if (c > 0) r.data[i++] = c;
    else if (c < -1) r.data[i++] = this.DV + c;
    r.t = i;
    r.clamp();
  }
  function bnAdd(a) {
    var r = nbi();
    this.addTo(a, r);
    return r;
  }
  function bnSubtract(a) {
    var r = nbi();
    this.subTo(a, r);
    return r;
  }
  function bnMultiply(a) {
    var r = nbi();
    this.multiplyTo(a, r);
    return r;
  }
  function bnSquare() {
    var r = nbi();
    this.squareTo(r);
    return r;
  }
  function bnDivide(a) {
    var r = nbi();
    this.divRemTo(a, r, null);
    return r;
  }
  function bnRemainder(a) {
    var r = nbi();
    this.divRemTo(a, null, r);
    return r;
  }
  function bnDivideAndRemainder(a) {
    var q = nbi(), r = nbi();
    this.divRemTo(a, q, r);
    return new Array(q, r);
  }
  function bnpDMultiply(n) {
    this.data[this.t] = this.am(0, n - 1, this, 0, 0, this.t);
    ++this.t;
    this.clamp();
  }
  function bnpDAddOffset(n, w) {
    if (n == 0) return;
    while (this.t <= w) this.data[this.t++] = 0;
    this.data[w] += n;
    while (this.data[w] >= this.DV) {
      this.data[w] -= this.DV;
      if (++w >= this.t) this.data[this.t++] = 0;
      ++this.data[w];
    }
  }
  function NullExp() {
  }
  function nNop(x) {
    return x;
  }
  function nMulTo(x, y, r) {
    x.multiplyTo(y, r);
  }
  function nSqrTo(x, r) {
    x.squareTo(r);
  }
  NullExp.prototype.convert = nNop;
  NullExp.prototype.revert = nNop;
  NullExp.prototype.mulTo = nMulTo;
  NullExp.prototype.sqrTo = nSqrTo;
  function bnPow(e) {
    return this.exp(e, new NullExp());
  }
  function bnpMultiplyLowerTo(a, n, r) {
    var i = Math.min(this.t + a.t, n);
    r.s = 0;
    r.t = i;
    while (i > 0) r.data[--i] = 0;
    var j;
    for (j = r.t - this.t; i < j; ++i) r.data[i + this.t] = this.am(0, a.data[i], r, i, 0, this.t);
    for (j = Math.min(a.t, n); i < j; ++i) this.am(0, a.data[i], r, i, 0, n - i);
    r.clamp();
  }
  function bnpMultiplyUpperTo(a, n, r) {
    --n;
    var i = r.t = this.t + a.t - n;
    r.s = 0;
    while (--i >= 0) r.data[i] = 0;
    for (i = Math.max(n - this.t, 0); i < a.t; ++i)
      r.data[this.t + i - n] = this.am(n - i, a.data[i], r, 0, 0, this.t + i - n);
    r.clamp();
    r.drShiftTo(1, r);
  }
  function Barrett(m) {
    this.r2 = nbi();
    this.q3 = nbi();
    BigInteger.ONE.dlShiftTo(2 * m.t, this.r2);
    this.mu = this.r2.divide(m);
    this.m = m;
  }
  function barrettConvert(x) {
    if (x.s < 0 || x.t > 2 * this.m.t) return x.mod(this.m);
    else if (x.compareTo(this.m) < 0) return x;
    else {
      var r = nbi();
      x.copyTo(r);
      this.reduce(r);
      return r;
    }
  }
  function barrettRevert(x) {
    return x;
  }
  function barrettReduce(x) {
    x.drShiftTo(this.m.t - 1, this.r2);
    if (x.t > this.m.t + 1) {
      x.t = this.m.t + 1;
      x.clamp();
    }
    this.mu.multiplyUpperTo(this.r2, this.m.t + 1, this.q3);
    this.m.multiplyLowerTo(this.q3, this.m.t + 1, this.r2);
    while (x.compareTo(this.r2) < 0) x.dAddOffset(1, this.m.t + 1);
    x.subTo(this.r2, x);
    while (x.compareTo(this.m) >= 0) x.subTo(this.m, x);
  }
  function barrettSqrTo(x, r) {
    x.squareTo(r);
    this.reduce(r);
  }
  function barrettMulTo(x, y, r) {
    x.multiplyTo(y, r);
    this.reduce(r);
  }
  Barrett.prototype.convert = barrettConvert;
  Barrett.prototype.revert = barrettRevert;
  Barrett.prototype.reduce = barrettReduce;
  Barrett.prototype.mulTo = barrettMulTo;
  Barrett.prototype.sqrTo = barrettSqrTo;
  function bnModPow(e, m) {
    var i = e.bitLength(), k, r = nbv(1), z;
    if (i <= 0) return r;
    else if (i < 18) k = 1;
    else if (i < 48) k = 3;
    else if (i < 144) k = 4;
    else if (i < 768) k = 5;
    else k = 6;
    if (i < 8)
      z = new Classic(m);
    else if (m.isEven())
      z = new Barrett(m);
    else
      z = new Montgomery(m);
    var g = new Array(), n = 3, k1 = k - 1, km = (1 << k) - 1;
    g[1] = z.convert(this);
    if (k > 1) {
      var g2 = nbi();
      z.sqrTo(g[1], g2);
      while (n <= km) {
        g[n] = nbi();
        z.mulTo(g2, g[n - 2], g[n]);
        n += 2;
      }
    }
    var j = e.t - 1, w, is1 = true, r2 = nbi(), t;
    i = nbits(e.data[j]) - 1;
    while (j >= 0) {
      if (i >= k1) w = e.data[j] >> i - k1 & km;
      else {
        w = (e.data[j] & (1 << i + 1) - 1) << k1 - i;
        if (j > 0) w |= e.data[j - 1] >> this.DB + i - k1;
      }
      n = k;
      while ((w & 1) == 0) {
        w >>= 1;
        --n;
      }
      if ((i -= n) < 0) {
        i += this.DB;
        --j;
      }
      if (is1) {
        g[w].copyTo(r);
        is1 = false;
      } else {
        while (n > 1) {
          z.sqrTo(r, r2);
          z.sqrTo(r2, r);
          n -= 2;
        }
        if (n > 0) z.sqrTo(r, r2);
        else {
          t = r;
          r = r2;
          r2 = t;
        }
        z.mulTo(r2, g[w], r);
      }
      while (j >= 0 && (e.data[j] & 1 << i) == 0) {
        z.sqrTo(r, r2);
        t = r;
        r = r2;
        r2 = t;
        if (--i < 0) {
          i = this.DB - 1;
          --j;
        }
      }
    }
    return z.revert(r);
  }
  function bnGCD(a) {
    var x = this.s < 0 ? this.negate() : this.clone();
    var y = a.s < 0 ? a.negate() : a.clone();
    if (x.compareTo(y) < 0) {
      var t = x;
      x = y;
      y = t;
    }
    var i = x.getLowestSetBit(), g = y.getLowestSetBit();
    if (g < 0) return x;
    if (i < g) g = i;
    if (g > 0) {
      x.rShiftTo(g, x);
      y.rShiftTo(g, y);
    }
    while (x.signum() > 0) {
      if ((i = x.getLowestSetBit()) > 0) x.rShiftTo(i, x);
      if ((i = y.getLowestSetBit()) > 0) y.rShiftTo(i, y);
      if (x.compareTo(y) >= 0) {
        x.subTo(y, x);
        x.rShiftTo(1, x);
      } else {
        y.subTo(x, y);
        y.rShiftTo(1, y);
      }
    }
    if (g > 0) y.lShiftTo(g, y);
    return y;
  }
  function bnpModInt(n) {
    if (n <= 0) return 0;
    var d = this.DV % n, r = this.s < 0 ? n - 1 : 0;
    if (this.t > 0)
      if (d == 0) r = this.data[0] % n;
      else for (var i = this.t - 1; i >= 0; --i) r = (d * r + this.data[i]) % n;
    return r;
  }
  function bnModInverse(m) {
    if (this.signum() == 0) {
      return BigInteger.ZERO;
    }
    var ac = m.isEven();
    if (this.isEven() && ac || m.signum() == 0) return BigInteger.ZERO;
    var u = m.clone(), v = this.clone();
    var a = nbv(1), b = nbv(0), c = nbv(0), d = nbv(1);
    while (u.signum() != 0) {
      while (u.isEven()) {
        u.rShiftTo(1, u);
        if (ac) {
          if (!a.isEven() || !b.isEven()) {
            a.addTo(this, a);
            b.subTo(m, b);
          }
          a.rShiftTo(1, a);
        } else if (!b.isEven()) b.subTo(m, b);
        b.rShiftTo(1, b);
      }
      while (v.isEven()) {
        v.rShiftTo(1, v);
        if (ac) {
          if (!c.isEven() || !d.isEven()) {
            c.addTo(this, c);
            d.subTo(m, d);
          }
          c.rShiftTo(1, c);
        } else if (!d.isEven()) d.subTo(m, d);
        d.rShiftTo(1, d);
      }
      if (u.compareTo(v) >= 0) {
        u.subTo(v, u);
        if (ac) a.subTo(c, a);
        b.subTo(d, b);
      } else {
        v.subTo(u, v);
        if (ac) c.subTo(a, c);
        d.subTo(b, d);
      }
    }
    if (v.compareTo(BigInteger.ONE) != 0) return BigInteger.ZERO;
    if (d.compareTo(m) >= 0) return d.subtract(m);
    if (d.signum() < 0) d.addTo(m, d);
    else return d;
    if (d.signum() < 0) return d.add(m);
    else return d;
  }
  var lowprimes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257, 263, 269, 271, 277, 281, 283, 293, 307, 311, 313, 317, 331, 337, 347, 349, 353, 359, 367, 373, 379, 383, 389, 397, 401, 409, 419, 421, 431, 433, 439, 443, 449, 457, 461, 463, 467, 479, 487, 491, 499, 503, 509, 521, 523, 541, 547, 557, 563, 569, 571, 577, 587, 593, 599, 601, 607, 613, 617, 619, 631, 641, 643, 647, 653, 659, 661, 673, 677, 683, 691, 701, 709, 719, 727, 733, 739, 743, 751, 757, 761, 769, 773, 787, 797, 809, 811, 821, 823, 827, 829, 839, 853, 857, 859, 863, 877, 881, 883, 887, 907, 911, 919, 929, 937, 941, 947, 953, 967, 971, 977, 983, 991, 997];
  var lplim = (1 << 26) / lowprimes[lowprimes.length - 1];
  function bnIsProbablePrime(t) {
    var i, x = this.abs();
    if (x.t == 1 && x.data[0] <= lowprimes[lowprimes.length - 1]) {
      for (i = 0; i < lowprimes.length; ++i)
        if (x.data[0] == lowprimes[i]) return true;
      return false;
    }
    if (x.isEven()) return false;
    i = 1;
    while (i < lowprimes.length) {
      var m = lowprimes[i], j = i + 1;
      while (j < lowprimes.length && m < lplim) m *= lowprimes[j++];
      m = x.modInt(m);
      while (i < j) if (m % lowprimes[i++] == 0) return false;
    }
    return x.millerRabin(t);
  }
  function bnpMillerRabin(t) {
    var n1 = this.subtract(BigInteger.ONE);
    var k = n1.getLowestSetBit();
    if (k <= 0) return false;
    var r = n1.shiftRight(k);
    var prng2 = bnGetPrng();
    var a;
    for (var i = 0; i < t; ++i) {
      do {
        a = new BigInteger(this.bitLength(), prng2);
      } while (a.compareTo(BigInteger.ONE) <= 0 || a.compareTo(n1) >= 0);
      var y = a.modPow(r, this);
      if (y.compareTo(BigInteger.ONE) != 0 && y.compareTo(n1) != 0) {
        var j = 1;
        while (j++ < k && y.compareTo(n1) != 0) {
          y = y.modPowInt(2, this);
          if (y.compareTo(BigInteger.ONE) == 0) return false;
        }
        if (y.compareTo(n1) != 0) return false;
      }
    }
    return true;
  }
  function bnGetPrng() {
    return {
      // x is an array to fill with bytes
      nextBytes: function(x) {
        for (var i = 0; i < x.length; ++i) {
          x[i] = Math.floor(Math.random() * 256);
        }
      }
    };
  }
  BigInteger.prototype.chunkSize = bnpChunkSize;
  BigInteger.prototype.toRadix = bnpToRadix;
  BigInteger.prototype.fromRadix = bnpFromRadix;
  BigInteger.prototype.fromNumber = bnpFromNumber;
  BigInteger.prototype.bitwiseTo = bnpBitwiseTo;
  BigInteger.prototype.changeBit = bnpChangeBit;
  BigInteger.prototype.addTo = bnpAddTo;
  BigInteger.prototype.dMultiply = bnpDMultiply;
  BigInteger.prototype.dAddOffset = bnpDAddOffset;
  BigInteger.prototype.multiplyLowerTo = bnpMultiplyLowerTo;
  BigInteger.prototype.multiplyUpperTo = bnpMultiplyUpperTo;
  BigInteger.prototype.modInt = bnpModInt;
  BigInteger.prototype.millerRabin = bnpMillerRabin;
  BigInteger.prototype.clone = bnClone;
  BigInteger.prototype.intValue = bnIntValue;
  BigInteger.prototype.byteValue = bnByteValue;
  BigInteger.prototype.shortValue = bnShortValue;
  BigInteger.prototype.signum = bnSigNum;
  BigInteger.prototype.toByteArray = bnToByteArray;
  BigInteger.prototype.equals = bnEquals;
  BigInteger.prototype.min = bnMin;
  BigInteger.prototype.max = bnMax;
  BigInteger.prototype.and = bnAnd;
  BigInteger.prototype.or = bnOr;
  BigInteger.prototype.xor = bnXor;
  BigInteger.prototype.andNot = bnAndNot;
  BigInteger.prototype.not = bnNot;
  BigInteger.prototype.shiftLeft = bnShiftLeft;
  BigInteger.prototype.shiftRight = bnShiftRight;
  BigInteger.prototype.getLowestSetBit = bnGetLowestSetBit;
  BigInteger.prototype.bitCount = bnBitCount;
  BigInteger.prototype.testBit = bnTestBit;
  BigInteger.prototype.setBit = bnSetBit;
  BigInteger.prototype.clearBit = bnClearBit;
  BigInteger.prototype.flipBit = bnFlipBit;
  BigInteger.prototype.add = bnAdd;
  BigInteger.prototype.subtract = bnSubtract;
  BigInteger.prototype.multiply = bnMultiply;
  BigInteger.prototype.divide = bnDivide;
  BigInteger.prototype.remainder = bnRemainder;
  BigInteger.prototype.divideAndRemainder = bnDivideAndRemainder;
  BigInteger.prototype.modPow = bnModPow;
  BigInteger.prototype.modInverse = bnModInverse;
  BigInteger.prototype.pow = bnPow;
  BigInteger.prototype.gcd = bnGCD;
  BigInteger.prototype.isProbablePrime = bnIsProbablePrime;
  BigInteger.prototype.square = bnSquare;
  return jsbn;
}
var pkcs1 = { exports: {} };
var sha1 = { exports: {} };
var hasRequiredSha1;
function requireSha1() {
  if (hasRequiredSha1) return sha1.exports;
  hasRequiredSha1 = 1;
  var forge2 = requireForge();
  requireMd();
  requireUtil();
  var sha1$1 = sha1.exports = forge2.sha1 = forge2.sha1 || {};
  forge2.md.sha1 = forge2.md.algorithms.sha1 = sha1$1;
  sha1$1.create = function() {
    if (!_initialized) {
      _init();
    }
    var _state = null;
    var _input = forge2.util.createBuffer();
    var _w = new Array(80);
    var md2 = {
      algorithm: "sha1",
      blockLength: 64,
      digestLength: 20,
      // 56-bit length of message so far (does not including padding)
      messageLength: 0,
      // true message length
      fullMessageLength: null,
      // size of message length in bytes
      messageLengthSize: 8
    };
    md2.start = function() {
      md2.messageLength = 0;
      md2.fullMessageLength = md2.messageLength64 = [];
      var int32s = md2.messageLengthSize / 4;
      for (var i = 0; i < int32s; ++i) {
        md2.fullMessageLength.push(0);
      }
      _input = forge2.util.createBuffer();
      _state = {
        h0: 1732584193,
        h1: 4023233417,
        h2: 2562383102,
        h3: 271733878,
        h4: 3285377520
      };
      return md2;
    };
    md2.start();
    md2.update = function(msg, encoding) {
      if (encoding === "utf8") {
        msg = forge2.util.encodeUtf8(msg);
      }
      var len = msg.length;
      md2.messageLength += len;
      len = [len / 4294967296 >>> 0, len >>> 0];
      for (var i = md2.fullMessageLength.length - 1; i >= 0; --i) {
        md2.fullMessageLength[i] += len[1];
        len[1] = len[0] + (md2.fullMessageLength[i] / 4294967296 >>> 0);
        md2.fullMessageLength[i] = md2.fullMessageLength[i] >>> 0;
        len[0] = len[1] / 4294967296 >>> 0;
      }
      _input.putBytes(msg);
      _update(_state, _w, _input);
      if (_input.read > 2048 || _input.length() === 0) {
        _input.compact();
      }
      return md2;
    };
    md2.digest = function() {
      var finalBlock = forge2.util.createBuffer();
      finalBlock.putBytes(_input.bytes());
      var remaining = md2.fullMessageLength[md2.fullMessageLength.length - 1] + md2.messageLengthSize;
      var overflow = remaining & md2.blockLength - 1;
      finalBlock.putBytes(_padding.substr(0, md2.blockLength - overflow));
      var next, carry;
      var bits = md2.fullMessageLength[0] * 8;
      for (var i = 0; i < md2.fullMessageLength.length - 1; ++i) {
        next = md2.fullMessageLength[i + 1] * 8;
        carry = next / 4294967296 >>> 0;
        bits += carry;
        finalBlock.putInt32(bits >>> 0);
        bits = next >>> 0;
      }
      finalBlock.putInt32(bits);
      var s2 = {
        h0: _state.h0,
        h1: _state.h1,
        h2: _state.h2,
        h3: _state.h3,
        h4: _state.h4
      };
      _update(s2, _w, finalBlock);
      var rval = forge2.util.createBuffer();
      rval.putInt32(s2.h0);
      rval.putInt32(s2.h1);
      rval.putInt32(s2.h2);
      rval.putInt32(s2.h3);
      rval.putInt32(s2.h4);
      return rval;
    };
    return md2;
  };
  var _padding = null;
  var _initialized = false;
  function _init() {
    _padding = String.fromCharCode(128);
    _padding += forge2.util.fillString(String.fromCharCode(0), 64);
    _initialized = true;
  }
  function _update(s, w, bytes) {
    var t, a, b, c, d, e, f, i;
    var len = bytes.length();
    while (len >= 64) {
      a = s.h0;
      b = s.h1;
      c = s.h2;
      d = s.h3;
      e = s.h4;
      for (i = 0; i < 16; ++i) {
        t = bytes.getInt32();
        w[i] = t;
        f = d ^ b & (c ^ d);
        t = (a << 5 | a >>> 27) + f + e + 1518500249 + t;
        e = d;
        d = c;
        c = (b << 30 | b >>> 2) >>> 0;
        b = a;
        a = t;
      }
      for (; i < 20; ++i) {
        t = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        t = t << 1 | t >>> 31;
        w[i] = t;
        f = d ^ b & (c ^ d);
        t = (a << 5 | a >>> 27) + f + e + 1518500249 + t;
        e = d;
        d = c;
        c = (b << 30 | b >>> 2) >>> 0;
        b = a;
        a = t;
      }
      for (; i < 32; ++i) {
        t = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        t = t << 1 | t >>> 31;
        w[i] = t;
        f = b ^ c ^ d;
        t = (a << 5 | a >>> 27) + f + e + 1859775393 + t;
        e = d;
        d = c;
        c = (b << 30 | b >>> 2) >>> 0;
        b = a;
        a = t;
      }
      for (; i < 40; ++i) {
        t = w[i - 6] ^ w[i - 16] ^ w[i - 28] ^ w[i - 32];
        t = t << 2 | t >>> 30;
        w[i] = t;
        f = b ^ c ^ d;
        t = (a << 5 | a >>> 27) + f + e + 1859775393 + t;
        e = d;
        d = c;
        c = (b << 30 | b >>> 2) >>> 0;
        b = a;
        a = t;
      }
      for (; i < 60; ++i) {
        t = w[i - 6] ^ w[i - 16] ^ w[i - 28] ^ w[i - 32];
        t = t << 2 | t >>> 30;
        w[i] = t;
        f = b & c | d & (b ^ c);
        t = (a << 5 | a >>> 27) + f + e + 2400959708 + t;
        e = d;
        d = c;
        c = (b << 30 | b >>> 2) >>> 0;
        b = a;
        a = t;
      }
      for (; i < 80; ++i) {
        t = w[i - 6] ^ w[i - 16] ^ w[i - 28] ^ w[i - 32];
        t = t << 2 | t >>> 30;
        w[i] = t;
        f = b ^ c ^ d;
        t = (a << 5 | a >>> 27) + f + e + 3395469782 + t;
        e = d;
        d = c;
        c = (b << 30 | b >>> 2) >>> 0;
        b = a;
        a = t;
      }
      s.h0 = s.h0 + a | 0;
      s.h1 = s.h1 + b | 0;
      s.h2 = s.h2 + c | 0;
      s.h3 = s.h3 + d | 0;
      s.h4 = s.h4 + e | 0;
      len -= 64;
    }
  }
  return sha1.exports;
}
var hasRequiredPkcs1;
function requirePkcs1() {
  if (hasRequiredPkcs1) return pkcs1.exports;
  hasRequiredPkcs1 = 1;
  var forge2 = requireForge();
  requireUtil();
  requireRandom();
  requireSha1();
  var pkcs1$1 = pkcs1.exports = forge2.pkcs1 = forge2.pkcs1 || {};
  pkcs1$1.encode_rsa_oaep = function(key, message, options) {
    var label;
    var seed;
    var md2;
    var mgf1Md;
    if (typeof options === "string") {
      label = options;
      seed = arguments[3] || void 0;
      md2 = arguments[4] || void 0;
    } else if (options) {
      label = options.label || void 0;
      seed = options.seed || void 0;
      md2 = options.md || void 0;
      if (options.mgf1 && options.mgf1.md) {
        mgf1Md = options.mgf1.md;
      }
    }
    if (!md2) {
      md2 = forge2.md.sha1.create();
    } else {
      md2.start();
    }
    if (!mgf1Md) {
      mgf1Md = md2;
    }
    var keyLength = Math.ceil(key.n.bitLength() / 8);
    var maxLength = keyLength - 2 * md2.digestLength - 2;
    if (message.length > maxLength) {
      var error = new Error("RSAES-OAEP input message length is too long.");
      error.length = message.length;
      error.maxLength = maxLength;
      throw error;
    }
    if (!label) {
      label = "";
    }
    md2.update(label, "raw");
    var lHash = md2.digest();
    var PS = "";
    var PS_length = maxLength - message.length;
    for (var i = 0; i < PS_length; i++) {
      PS += "\0";
    }
    var DB = lHash.getBytes() + PS + "" + message;
    if (!seed) {
      seed = forge2.random.getBytes(md2.digestLength);
    } else if (seed.length !== md2.digestLength) {
      var error = new Error("Invalid RSAES-OAEP seed. The seed length must match the digest length.");
      error.seedLength = seed.length;
      error.digestLength = md2.digestLength;
      throw error;
    }
    var dbMask = rsa_mgf1(seed, keyLength - md2.digestLength - 1, mgf1Md);
    var maskedDB = forge2.util.xorBytes(DB, dbMask, DB.length);
    var seedMask = rsa_mgf1(maskedDB, md2.digestLength, mgf1Md);
    var maskedSeed = forge2.util.xorBytes(seed, seedMask, seed.length);
    return "\0" + maskedSeed + maskedDB;
  };
  pkcs1$1.decode_rsa_oaep = function(key, em, options) {
    var label;
    var md2;
    var mgf1Md;
    if (typeof options === "string") {
      label = options;
      md2 = arguments[3] || void 0;
    } else if (options) {
      label = options.label || void 0;
      md2 = options.md || void 0;
      if (options.mgf1 && options.mgf1.md) {
        mgf1Md = options.mgf1.md;
      }
    }
    var keyLength = Math.ceil(key.n.bitLength() / 8);
    if (em.length !== keyLength) {
      var error = new Error("RSAES-OAEP encoded message length is invalid.");
      error.length = em.length;
      error.expectedLength = keyLength;
      throw error;
    }
    if (md2 === void 0) {
      md2 = forge2.md.sha1.create();
    } else {
      md2.start();
    }
    if (!mgf1Md) {
      mgf1Md = md2;
    }
    if (keyLength < 2 * md2.digestLength + 2) {
      throw new Error("RSAES-OAEP key is too short for the hash function.");
    }
    if (!label) {
      label = "";
    }
    md2.update(label, "raw");
    var lHash = md2.digest().getBytes();
    var y = em.charAt(0);
    var maskedSeed = em.substring(1, md2.digestLength + 1);
    var maskedDB = em.substring(1 + md2.digestLength);
    var seedMask = rsa_mgf1(maskedDB, md2.digestLength, mgf1Md);
    var seed = forge2.util.xorBytes(maskedSeed, seedMask, maskedSeed.length);
    var dbMask = rsa_mgf1(seed, keyLength - md2.digestLength - 1, mgf1Md);
    var db = forge2.util.xorBytes(maskedDB, dbMask, maskedDB.length);
    var lHashPrime = db.substring(0, md2.digestLength);
    var error = y !== "\0";
    for (var i = 0; i < md2.digestLength; ++i) {
      error |= lHash.charAt(i) !== lHashPrime.charAt(i);
    }
    var in_ps = 1;
    var index = md2.digestLength;
    for (var j = md2.digestLength; j < db.length; j++) {
      var code = db.charCodeAt(j);
      var is_0 = code & 1 ^ 1;
      var error_mask = in_ps ? 65534 : 0;
      error |= code & error_mask;
      in_ps = in_ps & is_0;
      index += in_ps;
    }
    if (error || db.charCodeAt(index) !== 1) {
      throw new Error("Invalid RSAES-OAEP padding.");
    }
    return db.substring(index + 1);
  };
  function rsa_mgf1(seed, maskLength, hash) {
    if (!hash) {
      hash = forge2.md.sha1.create();
    }
    var t = "";
    var count = Math.ceil(maskLength / hash.digestLength);
    for (var i = 0; i < count; ++i) {
      var c = String.fromCharCode(
        i >> 24 & 255,
        i >> 16 & 255,
        i >> 8 & 255,
        i & 255
      );
      hash.start();
      hash.update(seed + c);
      t += hash.digest().getBytes();
    }
    return t.substring(0, maskLength);
  }
  return pkcs1.exports;
}
var prime = { exports: {} };
var hasRequiredPrime;
function requirePrime() {
  if (hasRequiredPrime) return prime.exports;
  hasRequiredPrime = 1;
  var forge2 = requireForge();
  requireUtil();
  requireJsbn();
  requireRandom();
  (function() {
    if (forge2.prime) {
      prime.exports = forge2.prime;
      return;
    }
    var prime$1 = prime.exports = forge2.prime = forge2.prime || {};
    var BigInteger = forge2.jsbn.BigInteger;
    var GCD_30_DELTA = [6, 4, 2, 4, 2, 4, 6, 2];
    var THIRTY = new BigInteger(null);
    THIRTY.fromInt(30);
    var op_or = function(x, y) {
      return x | y;
    };
    prime$1.generateProbablePrime = function(bits, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      options = options || {};
      var algorithm = options.algorithm || "PRIMEINC";
      if (typeof algorithm === "string") {
        algorithm = { name: algorithm };
      }
      algorithm.options = algorithm.options || {};
      var prng2 = options.prng || forge2.random;
      var rng = {
        // x is an array to fill with bytes
        nextBytes: function(x) {
          var b = prng2.getBytesSync(x.length);
          for (var i = 0; i < x.length; ++i) {
            x[i] = b.charCodeAt(i);
          }
        }
      };
      if (algorithm.name === "PRIMEINC") {
        return primeincFindPrime(bits, rng, algorithm.options, callback);
      }
      throw new Error("Invalid prime generation algorithm: " + algorithm.name);
    };
    function primeincFindPrime(bits, rng, options, callback) {
      if ("workers" in options) {
        return primeincFindPrimeWithWorkers(bits, rng, options, callback);
      }
      return primeincFindPrimeWithoutWorkers(bits, rng, options, callback);
    }
    function primeincFindPrimeWithoutWorkers(bits, rng, options, callback) {
      var num = generateRandom(bits, rng);
      var deltaIdx = 0;
      var mrTests = getMillerRabinTests(num.bitLength());
      if ("millerRabinTests" in options) {
        mrTests = options.millerRabinTests;
      }
      var maxBlockTime = 10;
      if ("maxBlockTime" in options) {
        maxBlockTime = options.maxBlockTime;
      }
      _primeinc(num, bits, rng, deltaIdx, mrTests, maxBlockTime, callback);
    }
    function _primeinc(num, bits, rng, deltaIdx, mrTests, maxBlockTime, callback) {
      var start = +/* @__PURE__ */ new Date();
      do {
        if (num.bitLength() > bits) {
          num = generateRandom(bits, rng);
        }
        if (num.isProbablePrime(mrTests)) {
          return callback(null, num);
        }
        num.dAddOffset(GCD_30_DELTA[deltaIdx++ % 8], 0);
      } while (maxBlockTime < 0 || +/* @__PURE__ */ new Date() - start < maxBlockTime);
      forge2.util.setImmediate(function() {
        _primeinc(num, bits, rng, deltaIdx, mrTests, maxBlockTime, callback);
      });
    }
    function primeincFindPrimeWithWorkers(bits, rng, options, callback) {
      if (typeof Worker === "undefined") {
        return primeincFindPrimeWithoutWorkers(bits, rng, options, callback);
      }
      var num = generateRandom(bits, rng);
      var numWorkers = options.workers;
      var workLoad = options.workLoad || 100;
      var range = workLoad * 30 / 8;
      var workerScript = options.workerScript || "forge/prime.worker.js";
      if (numWorkers === -1) {
        return forge2.util.estimateCores(function(err, cores) {
          if (err) {
            cores = 2;
          }
          numWorkers = cores - 1;
          generate();
        });
      }
      generate();
      function generate() {
        numWorkers = Math.max(1, numWorkers);
        var workers = [];
        for (var i = 0; i < numWorkers; ++i) {
          workers[i] = new Worker(workerScript);
        }
        for (var i = 0; i < numWorkers; ++i) {
          workers[i].addEventListener("message", workerMessage);
        }
        var found = false;
        function workerMessage(e) {
          if (found) {
            return;
          }
          var data = e.data;
          if (data.found) {
            for (var i2 = 0; i2 < workers.length; ++i2) {
              workers[i2].terminate();
            }
            found = true;
            return callback(null, new BigInteger(data.prime, 16));
          }
          if (num.bitLength() > bits) {
            num = generateRandom(bits, rng);
          }
          var hex = num.toString(16);
          e.target.postMessage({
            hex,
            workLoad
          });
          num.dAddOffset(range, 0);
        }
      }
    }
    function generateRandom(bits, rng) {
      var num = new BigInteger(bits, rng);
      var bits1 = bits - 1;
      if (!num.testBit(bits1)) {
        num.bitwiseTo(BigInteger.ONE.shiftLeft(bits1), op_or, num);
      }
      num.dAddOffset(31 - num.mod(THIRTY).byteValue(), 0);
      return num;
    }
    function getMillerRabinTests(bits) {
      if (bits <= 100) return 27;
      if (bits <= 150) return 18;
      if (bits <= 200) return 15;
      if (bits <= 250) return 12;
      if (bits <= 300) return 9;
      if (bits <= 350) return 8;
      if (bits <= 400) return 7;
      if (bits <= 500) return 6;
      if (bits <= 600) return 5;
      if (bits <= 800) return 4;
      if (bits <= 1250) return 3;
      return 2;
    }
  })();
  return prime.exports;
}
var rsa;
var hasRequiredRsa;
function requireRsa() {
  if (hasRequiredRsa) return rsa;
  hasRequiredRsa = 1;
  var forge2 = requireForge();
  requireAsn1();
  requireJsbn();
  requireOids();
  requirePkcs1();
  requirePrime();
  requireRandom();
  requireUtil();
  if (typeof BigInteger === "undefined") {
    var BigInteger = forge2.jsbn.BigInteger;
  }
  var _crypto = forge2.util.isNodejs ? require$$3 : null;
  var asn12 = forge2.asn1;
  var util2 = forge2.util;
  forge2.pki = forge2.pki || {};
  rsa = forge2.pki.rsa = forge2.rsa = forge2.rsa || {};
  var pki2 = forge2.pki;
  var GCD_30_DELTA = [6, 4, 2, 4, 2, 4, 6, 2];
  var privateKeyValidator = {
    // PrivateKeyInfo
    name: "PrivateKeyInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      // Version (INTEGER)
      name: "PrivateKeyInfo.version",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyVersion"
    }, {
      // privateKeyAlgorithm
      name: "PrivateKeyInfo.privateKeyAlgorithm",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "AlgorithmIdentifier.algorithm",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "privateKeyOid"
      }]
    }, {
      // PrivateKey
      name: "PrivateKeyInfo",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OCTETSTRING,
      constructed: false,
      capture: "privateKey"
    }]
  };
  var rsaPrivateKeyValidator = {
    // RSAPrivateKey
    name: "RSAPrivateKey",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      // Version (INTEGER)
      name: "RSAPrivateKey.version",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyVersion"
    }, {
      // modulus (n)
      name: "RSAPrivateKey.modulus",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyModulus"
    }, {
      // publicExponent (e)
      name: "RSAPrivateKey.publicExponent",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyPublicExponent"
    }, {
      // privateExponent (d)
      name: "RSAPrivateKey.privateExponent",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyPrivateExponent"
    }, {
      // prime1 (p)
      name: "RSAPrivateKey.prime1",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyPrime1"
    }, {
      // prime2 (q)
      name: "RSAPrivateKey.prime2",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyPrime2"
    }, {
      // exponent1 (d mod (p-1))
      name: "RSAPrivateKey.exponent1",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyExponent1"
    }, {
      // exponent2 (d mod (q-1))
      name: "RSAPrivateKey.exponent2",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyExponent2"
    }, {
      // coefficient ((inverse of q) mod p)
      name: "RSAPrivateKey.coefficient",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyCoefficient"
    }]
  };
  var rsaPublicKeyValidator = {
    // RSAPublicKey
    name: "RSAPublicKey",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      // modulus (n)
      name: "RSAPublicKey.modulus",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "publicKeyModulus"
    }, {
      // publicExponent (e)
      name: "RSAPublicKey.exponent",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "publicKeyExponent"
    }]
  };
  var publicKeyValidator = forge2.pki.rsa.publicKeyValidator = {
    name: "SubjectPublicKeyInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    captureAsn1: "subjectPublicKeyInfo",
    value: [{
      name: "SubjectPublicKeyInfo.AlgorithmIdentifier",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "AlgorithmIdentifier.algorithm",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "publicKeyOid"
      }]
    }, {
      // subjectPublicKey
      name: "SubjectPublicKeyInfo.subjectPublicKey",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.BITSTRING,
      constructed: false,
      value: [{
        // RSAPublicKey
        name: "SubjectPublicKeyInfo.subjectPublicKey.RSAPublicKey",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SEQUENCE,
        constructed: true,
        optional: true,
        captureAsn1: "rsaPublicKey"
      }]
    }]
  };
  var digestInfoValidator = {
    name: "DigestInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "DigestInfo.DigestAlgorithm",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "DigestInfo.DigestAlgorithm.algorithmIdentifier",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "algorithmIdentifier"
      }, {
        // NULL parameters
        name: "DigestInfo.DigestAlgorithm.parameters",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.NULL,
        // captured only to check existence for md2 and md5
        capture: "parameters",
        optional: true,
        constructed: false
      }]
    }, {
      // digest
      name: "DigestInfo.digest",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OCTETSTRING,
      constructed: false,
      capture: "digest"
    }]
  };
  var emsaPkcs1v15encode = function(md2) {
    var oid;
    if (md2.algorithm in pki2.oids) {
      oid = pki2.oids[md2.algorithm];
    } else {
      var error = new Error("Unknown message digest algorithm.");
      error.algorithm = md2.algorithm;
      throw error;
    }
    var oidBytes = asn12.oidToDer(oid).getBytes();
    var digestInfo = asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.SEQUENCE,
      true,
      []
    );
    var digestAlgorithm = asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.SEQUENCE,
      true,
      []
    );
    digestAlgorithm.value.push(asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.OID,
      false,
      oidBytes
    ));
    digestAlgorithm.value.push(asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.NULL,
      false,
      ""
    ));
    var digest = asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.OCTETSTRING,
      false,
      md2.digest().getBytes()
    );
    digestInfo.value.push(digestAlgorithm);
    digestInfo.value.push(digest);
    return asn12.toDer(digestInfo).getBytes();
  };
  var _modPow = function(x, key, pub) {
    if (pub) {
      return x.modPow(key.e, key.n);
    }
    if (!key.p || !key.q) {
      return x.modPow(key.d, key.n);
    }
    if (!key.dP) {
      key.dP = key.d.mod(key.p.subtract(BigInteger.ONE));
    }
    if (!key.dQ) {
      key.dQ = key.d.mod(key.q.subtract(BigInteger.ONE));
    }
    if (!key.qInv) {
      key.qInv = key.q.modInverse(key.p);
    }
    var r;
    do {
      r = new BigInteger(
        forge2.util.bytesToHex(forge2.random.getBytes(key.n.bitLength() / 8)),
        16
      );
    } while (r.compareTo(key.n) >= 0 || !r.gcd(key.n).equals(BigInteger.ONE));
    x = x.multiply(r.modPow(key.e, key.n)).mod(key.n);
    var xp = x.mod(key.p).modPow(key.dP, key.p);
    var xq = x.mod(key.q).modPow(key.dQ, key.q);
    while (xp.compareTo(xq) < 0) {
      xp = xp.add(key.p);
    }
    var y = xp.subtract(xq).multiply(key.qInv).mod(key.p).multiply(key.q).add(xq);
    y = y.multiply(r.modInverse(key.n)).mod(key.n);
    return y;
  };
  pki2.rsa.encrypt = function(m, key, bt) {
    var pub = bt;
    var eb;
    var k = Math.ceil(key.n.bitLength() / 8);
    if (bt !== false && bt !== true) {
      pub = bt === 2;
      eb = _encodePkcs1_v1_5(m, key, bt);
    } else {
      eb = forge2.util.createBuffer();
      eb.putBytes(m);
    }
    var x = new BigInteger(eb.toHex(), 16);
    var y = _modPow(x, key, pub);
    var yhex = y.toString(16);
    var ed = forge2.util.createBuffer();
    var zeros = k - Math.ceil(yhex.length / 2);
    while (zeros > 0) {
      ed.putByte(0);
      --zeros;
    }
    ed.putBytes(forge2.util.hexToBytes(yhex));
    return ed.getBytes();
  };
  pki2.rsa.decrypt = function(ed, key, pub, ml) {
    var k = Math.ceil(key.n.bitLength() / 8);
    if (ed.length !== k) {
      var error = new Error("Encrypted message length is invalid.");
      error.length = ed.length;
      error.expected = k;
      throw error;
    }
    var y = new BigInteger(forge2.util.createBuffer(ed).toHex(), 16);
    if (y.compareTo(key.n) >= 0) {
      throw new Error("Encrypted message is invalid.");
    }
    var x = _modPow(y, key, pub);
    var xhex = x.toString(16);
    var eb = forge2.util.createBuffer();
    var zeros = k - Math.ceil(xhex.length / 2);
    while (zeros > 0) {
      eb.putByte(0);
      --zeros;
    }
    eb.putBytes(forge2.util.hexToBytes(xhex));
    if (ml !== false) {
      return _decodePkcs1_v1_5(eb.getBytes(), key, pub);
    }
    return eb.getBytes();
  };
  pki2.rsa.createKeyPairGenerationState = function(bits, e, options) {
    if (typeof bits === "string") {
      bits = parseInt(bits, 10);
    }
    bits = bits || 2048;
    options = options || {};
    var prng2 = options.prng || forge2.random;
    var rng = {
      // x is an array to fill with bytes
      nextBytes: function(x) {
        var b = prng2.getBytesSync(x.length);
        for (var i = 0; i < x.length; ++i) {
          x[i] = b.charCodeAt(i);
        }
      }
    };
    var algorithm = options.algorithm || "PRIMEINC";
    var rval;
    if (algorithm === "PRIMEINC") {
      rval = {
        algorithm,
        state: 0,
        bits,
        rng,
        eInt: e || 65537,
        e: new BigInteger(null),
        p: null,
        q: null,
        qBits: bits >> 1,
        pBits: bits - (bits >> 1),
        pqState: 0,
        num: null,
        keys: null
      };
      rval.e.fromInt(rval.eInt);
    } else {
      throw new Error("Invalid key generation algorithm: " + algorithm);
    }
    return rval;
  };
  pki2.rsa.stepKeyPairGenerationState = function(state, n) {
    if (!("algorithm" in state)) {
      state.algorithm = "PRIMEINC";
    }
    var THIRTY = new BigInteger(null);
    THIRTY.fromInt(30);
    var deltaIdx = 0;
    var op_or = function(x, y) {
      return x | y;
    };
    var t1 = +/* @__PURE__ */ new Date();
    var t2;
    var total = 0;
    while (state.keys === null && (n <= 0 || total < n)) {
      if (state.state === 0) {
        var bits = state.p === null ? state.pBits : state.qBits;
        var bits1 = bits - 1;
        if (state.pqState === 0) {
          state.num = new BigInteger(bits, state.rng);
          if (!state.num.testBit(bits1)) {
            state.num.bitwiseTo(
              BigInteger.ONE.shiftLeft(bits1),
              op_or,
              state.num
            );
          }
          state.num.dAddOffset(31 - state.num.mod(THIRTY).byteValue(), 0);
          deltaIdx = 0;
          ++state.pqState;
        } else if (state.pqState === 1) {
          if (state.num.bitLength() > bits) {
            state.pqState = 0;
          } else if (state.num.isProbablePrime(
            _getMillerRabinTests(state.num.bitLength())
          )) {
            ++state.pqState;
          } else {
            state.num.dAddOffset(GCD_30_DELTA[deltaIdx++ % 8], 0);
          }
        } else if (state.pqState === 2) {
          state.pqState = state.num.subtract(BigInteger.ONE).gcd(state.e).compareTo(BigInteger.ONE) === 0 ? 3 : 0;
        } else if (state.pqState === 3) {
          state.pqState = 0;
          if (state.p === null) {
            state.p = state.num;
          } else {
            state.q = state.num;
          }
          if (state.p !== null && state.q !== null) {
            ++state.state;
          }
          state.num = null;
        }
      } else if (state.state === 1) {
        if (state.p.compareTo(state.q) < 0) {
          state.num = state.p;
          state.p = state.q;
          state.q = state.num;
        }
        ++state.state;
      } else if (state.state === 2) {
        state.p1 = state.p.subtract(BigInteger.ONE);
        state.q1 = state.q.subtract(BigInteger.ONE);
        state.phi = state.p1.multiply(state.q1);
        ++state.state;
      } else if (state.state === 3) {
        if (state.phi.gcd(state.e).compareTo(BigInteger.ONE) === 0) {
          ++state.state;
        } else {
          state.p = null;
          state.q = null;
          state.state = 0;
        }
      } else if (state.state === 4) {
        state.n = state.p.multiply(state.q);
        if (state.n.bitLength() === state.bits) {
          ++state.state;
        } else {
          state.q = null;
          state.state = 0;
        }
      } else if (state.state === 5) {
        var d = state.e.modInverse(state.phi);
        state.keys = {
          privateKey: pki2.rsa.setPrivateKey(
            state.n,
            state.e,
            d,
            state.p,
            state.q,
            d.mod(state.p1),
            d.mod(state.q1),
            state.q.modInverse(state.p)
          ),
          publicKey: pki2.rsa.setPublicKey(state.n, state.e)
        };
      }
      t2 = +/* @__PURE__ */ new Date();
      total += t2 - t1;
      t1 = t2;
    }
    return state.keys !== null;
  };
  pki2.rsa.generateKeyPair = function(bits, e, options, callback) {
    if (arguments.length === 1) {
      if (typeof bits === "object") {
        options = bits;
        bits = void 0;
      } else if (typeof bits === "function") {
        callback = bits;
        bits = void 0;
      }
    } else if (arguments.length === 2) {
      if (typeof bits === "number") {
        if (typeof e === "function") {
          callback = e;
          e = void 0;
        } else if (typeof e !== "number") {
          options = e;
          e = void 0;
        }
      } else {
        options = bits;
        callback = e;
        bits = void 0;
        e = void 0;
      }
    } else if (arguments.length === 3) {
      if (typeof e === "number") {
        if (typeof options === "function") {
          callback = options;
          options = void 0;
        }
      } else {
        callback = options;
        options = e;
        e = void 0;
      }
    }
    options = options || {};
    if (bits === void 0) {
      bits = options.bits || 2048;
    }
    if (e === void 0) {
      e = options.e || 65537;
    }
    if (!forge2.options.usePureJavaScript && !options.prng && bits >= 256 && bits <= 16384 && (e === 65537 || e === 3)) {
      if (callback) {
        if (_detectNodeCrypto("generateKeyPair")) {
          return _crypto.generateKeyPair("rsa", {
            modulusLength: bits,
            publicExponent: e,
            publicKeyEncoding: {
              type: "spki",
              format: "pem"
            },
            privateKeyEncoding: {
              type: "pkcs8",
              format: "pem"
            }
          }, function(err, pub, priv) {
            if (err) {
              return callback(err);
            }
            callback(null, {
              privateKey: pki2.privateKeyFromPem(priv),
              publicKey: pki2.publicKeyFromPem(pub)
            });
          });
        }
        if (_detectSubtleCrypto("generateKey") && _detectSubtleCrypto("exportKey")) {
          return util2.globalScope.crypto.subtle.generateKey({
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: bits,
            publicExponent: _intToUint8Array(e),
            hash: { name: "SHA-256" }
          }, true, ["sign", "verify"]).then(function(pair) {
            return util2.globalScope.crypto.subtle.exportKey(
              "pkcs8",
              pair.privateKey
            );
          }).then(void 0, function(err) {
            callback(err);
          }).then(function(pkcs8) {
            if (pkcs8) {
              var privateKey = pki2.privateKeyFromAsn1(
                asn12.fromDer(forge2.util.createBuffer(pkcs8))
              );
              callback(null, {
                privateKey,
                publicKey: pki2.setRsaPublicKey(privateKey.n, privateKey.e)
              });
            }
          });
        }
        if (_detectSubtleMsCrypto("generateKey") && _detectSubtleMsCrypto("exportKey")) {
          var genOp = util2.globalScope.msCrypto.subtle.generateKey({
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: bits,
            publicExponent: _intToUint8Array(e),
            hash: { name: "SHA-256" }
          }, true, ["sign", "verify"]);
          genOp.oncomplete = function(e2) {
            var pair = e2.target.result;
            var exportOp = util2.globalScope.msCrypto.subtle.exportKey(
              "pkcs8",
              pair.privateKey
            );
            exportOp.oncomplete = function(e3) {
              var pkcs8 = e3.target.result;
              var privateKey = pki2.privateKeyFromAsn1(
                asn12.fromDer(forge2.util.createBuffer(pkcs8))
              );
              callback(null, {
                privateKey,
                publicKey: pki2.setRsaPublicKey(privateKey.n, privateKey.e)
              });
            };
            exportOp.onerror = function(err) {
              callback(err);
            };
          };
          genOp.onerror = function(err) {
            callback(err);
          };
          return;
        }
      } else {
        if (_detectNodeCrypto("generateKeyPairSync")) {
          var keypair = _crypto.generateKeyPairSync("rsa", {
            modulusLength: bits,
            publicExponent: e,
            publicKeyEncoding: {
              type: "spki",
              format: "pem"
            },
            privateKeyEncoding: {
              type: "pkcs8",
              format: "pem"
            }
          });
          return {
            privateKey: pki2.privateKeyFromPem(keypair.privateKey),
            publicKey: pki2.publicKeyFromPem(keypair.publicKey)
          };
        }
      }
    }
    var state = pki2.rsa.createKeyPairGenerationState(bits, e, options);
    if (!callback) {
      pki2.rsa.stepKeyPairGenerationState(state, 0);
      return state.keys;
    }
    _generateKeyPair(state, options, callback);
  };
  pki2.setRsaPublicKey = pki2.rsa.setPublicKey = function(n, e) {
    var key = {
      n,
      e
    };
    key.encrypt = function(data, scheme, schemeOptions) {
      if (typeof scheme === "string") {
        scheme = scheme.toUpperCase();
      } else if (scheme === void 0) {
        scheme = "RSAES-PKCS1-V1_5";
      }
      if (scheme === "RSAES-PKCS1-V1_5") {
        scheme = {
          encode: function(m, key2, pub) {
            return _encodePkcs1_v1_5(m, key2, 2).getBytes();
          }
        };
      } else if (scheme === "RSA-OAEP" || scheme === "RSAES-OAEP") {
        scheme = {
          encode: function(m, key2) {
            return forge2.pkcs1.encode_rsa_oaep(key2, m, schemeOptions);
          }
        };
      } else if (["RAW", "NONE", "NULL", null].indexOf(scheme) !== -1) {
        scheme = { encode: function(e3) {
          return e3;
        } };
      } else if (typeof scheme === "string") {
        throw new Error('Unsupported encryption scheme: "' + scheme + '".');
      }
      var e2 = scheme.encode(data, key, true);
      return pki2.rsa.encrypt(e2, key, true);
    };
    key.verify = function(digest, signature, scheme, options) {
      if (typeof scheme === "string") {
        scheme = scheme.toUpperCase();
      } else if (scheme === void 0) {
        scheme = "RSASSA-PKCS1-V1_5";
      }
      if (options === void 0) {
        options = {
          _parseAllDigestBytes: true,
          _skipPaddingChecks: false
        };
      }
      if (!("_parseAllDigestBytes" in options)) {
        options._parseAllDigestBytes = true;
      }
      if (!("_skipPaddingChecks" in options)) {
        options._skipPaddingChecks = false;
      }
      if (scheme === "RSASSA-PKCS1-V1_5") {
        scheme = {
          verify: function(digest2, d2) {
            d2 = _decodePkcs1_v1_5(d2, key, true, void 0, options);
            var obj = asn12.fromDer(d2, {
              parseAllBytes: options._parseAllDigestBytes
            });
            var capture = {};
            var errors = [];
            if (!asn12.validate(obj, digestInfoValidator, capture, errors) || obj.value.length !== 2) {
              var error = new Error(
                "ASN.1 object does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo value."
              );
              error.errors = errors;
              throw error;
            }
            var oid = asn12.derToOid(capture.algorithmIdentifier);
            if (!(oid === forge2.oids.md2 || oid === forge2.oids.md5 || oid === forge2.oids.sha1 || oid === forge2.oids.sha224 || oid === forge2.oids.sha256 || oid === forge2.oids.sha384 || oid === forge2.oids.sha512 || oid === forge2.oids["sha512-224"] || oid === forge2.oids["sha512-256"])) {
              var error = new Error(
                "Unknown RSASSA-PKCS1-v1_5 DigestAlgorithm identifier."
              );
              error.oid = oid;
              throw error;
            }
            if (oid === forge2.oids.md2 || oid === forge2.oids.md5) {
              if (!("parameters" in capture)) {
                throw new Error(
                  "ASN.1 object does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo value. Missing algorithm identifier NULL parameters."
                );
              }
            }
            return digest2 === capture.digest;
          }
        };
      } else if (scheme === "NONE" || scheme === "NULL" || scheme === null) {
        scheme = {
          verify: function(digest2, d2) {
            d2 = _decodePkcs1_v1_5(d2, key, true, void 0, options);
            return digest2 === d2;
          }
        };
      }
      var d = pki2.rsa.decrypt(signature, key, true, false);
      return scheme.verify(digest, d, key.n.bitLength());
    };
    return key;
  };
  pki2.setRsaPrivateKey = pki2.rsa.setPrivateKey = function(n, e, d, p, q, dP, dQ, qInv) {
    var key = {
      n,
      e,
      d,
      p,
      q,
      dP,
      dQ,
      qInv
    };
    key.decrypt = function(data, scheme, schemeOptions) {
      if (typeof scheme === "string") {
        scheme = scheme.toUpperCase();
      } else if (scheme === void 0) {
        scheme = "RSAES-PKCS1-V1_5";
      }
      var d2 = pki2.rsa.decrypt(data, key, false, false);
      if (scheme === "RSAES-PKCS1-V1_5") {
        scheme = { decode: _decodePkcs1_v1_5 };
      } else if (scheme === "RSA-OAEP" || scheme === "RSAES-OAEP") {
        scheme = {
          decode: function(d3, key2) {
            return forge2.pkcs1.decode_rsa_oaep(key2, d3, schemeOptions);
          }
        };
      } else if (["RAW", "NONE", "NULL", null].indexOf(scheme) !== -1) {
        scheme = { decode: function(d3) {
          return d3;
        } };
      } else {
        throw new Error('Unsupported encryption scheme: "' + scheme + '".');
      }
      return scheme.decode(d2, key, false);
    };
    key.sign = function(md2, scheme) {
      var bt = false;
      if (typeof scheme === "string") {
        scheme = scheme.toUpperCase();
      }
      if (scheme === void 0 || scheme === "RSASSA-PKCS1-V1_5") {
        scheme = { encode: emsaPkcs1v15encode };
        bt = 1;
      } else if (scheme === "NONE" || scheme === "NULL" || scheme === null) {
        scheme = { encode: function() {
          return md2;
        } };
        bt = 1;
      }
      var d2 = scheme.encode(md2, key.n.bitLength());
      return pki2.rsa.encrypt(d2, key, bt);
    };
    return key;
  };
  pki2.wrapRsaPrivateKey = function(rsaKey) {
    return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // version (0)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        asn12.integerToDer(0).getBytes()
      ),
      // privateKeyAlgorithm
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(pki2.oids.rsaEncryption).getBytes()
        ),
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
      ]),
      // PrivateKey
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OCTETSTRING,
        false,
        asn12.toDer(rsaKey).getBytes()
      )
    ]);
  };
  pki2.privateKeyFromAsn1 = function(obj) {
    var capture = {};
    var errors = [];
    if (asn12.validate(obj, privateKeyValidator, capture, errors)) {
      obj = asn12.fromDer(forge2.util.createBuffer(capture.privateKey));
    }
    capture = {};
    errors = [];
    if (!asn12.validate(obj, rsaPrivateKeyValidator, capture, errors)) {
      var error = new Error("Cannot read private key. ASN.1 object does not contain an RSAPrivateKey.");
      error.errors = errors;
      throw error;
    }
    var n, e, d, p, q, dP, dQ, qInv;
    n = forge2.util.createBuffer(capture.privateKeyModulus).toHex();
    e = forge2.util.createBuffer(capture.privateKeyPublicExponent).toHex();
    d = forge2.util.createBuffer(capture.privateKeyPrivateExponent).toHex();
    p = forge2.util.createBuffer(capture.privateKeyPrime1).toHex();
    q = forge2.util.createBuffer(capture.privateKeyPrime2).toHex();
    dP = forge2.util.createBuffer(capture.privateKeyExponent1).toHex();
    dQ = forge2.util.createBuffer(capture.privateKeyExponent2).toHex();
    qInv = forge2.util.createBuffer(capture.privateKeyCoefficient).toHex();
    return pki2.setRsaPrivateKey(
      new BigInteger(n, 16),
      new BigInteger(e, 16),
      new BigInteger(d, 16),
      new BigInteger(p, 16),
      new BigInteger(q, 16),
      new BigInteger(dP, 16),
      new BigInteger(dQ, 16),
      new BigInteger(qInv, 16)
    );
  };
  pki2.privateKeyToAsn1 = pki2.privateKeyToRSAPrivateKey = function(key) {
    return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // version (0 = only 2 primes, 1 multiple primes)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        asn12.integerToDer(0).getBytes()
      ),
      // modulus (n)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.n)
      ),
      // publicExponent (e)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.e)
      ),
      // privateExponent (d)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.d)
      ),
      // privateKeyPrime1 (p)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.p)
      ),
      // privateKeyPrime2 (q)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.q)
      ),
      // privateKeyExponent1 (dP)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.dP)
      ),
      // privateKeyExponent2 (dQ)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.dQ)
      ),
      // coefficient (qInv)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.qInv)
      )
    ]);
  };
  pki2.publicKeyFromAsn1 = function(obj) {
    var capture = {};
    var errors = [];
    if (asn12.validate(obj, publicKeyValidator, capture, errors)) {
      var oid = asn12.derToOid(capture.publicKeyOid);
      if (oid !== pki2.oids.rsaEncryption) {
        var error = new Error("Cannot read public key. Unknown OID.");
        error.oid = oid;
        throw error;
      }
      obj = capture.rsaPublicKey;
    }
    errors = [];
    if (!asn12.validate(obj, rsaPublicKeyValidator, capture, errors)) {
      var error = new Error("Cannot read public key. ASN.1 object does not contain an RSAPublicKey.");
      error.errors = errors;
      throw error;
    }
    var n = forge2.util.createBuffer(capture.publicKeyModulus).toHex();
    var e = forge2.util.createBuffer(capture.publicKeyExponent).toHex();
    return pki2.setRsaPublicKey(
      new BigInteger(n, 16),
      new BigInteger(e, 16)
    );
  };
  pki2.publicKeyToAsn1 = pki2.publicKeyToSubjectPublicKeyInfo = function(key) {
    return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // AlgorithmIdentifier
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // algorithm
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(pki2.oids.rsaEncryption).getBytes()
        ),
        // parameters (null)
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
      ]),
      // subjectPublicKey
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.BITSTRING, false, [
        pki2.publicKeyToRSAPublicKey(key)
      ])
    ]);
  };
  pki2.publicKeyToRSAPublicKey = function(key) {
    return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // modulus (n)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.n)
      ),
      // publicExponent (e)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        _bnToBytes(key.e)
      )
    ]);
  };
  function _encodePkcs1_v1_5(m, key, bt) {
    var eb = forge2.util.createBuffer();
    var k = Math.ceil(key.n.bitLength() / 8);
    if (m.length > k - 11) {
      var error = new Error("Message is too long for PKCS#1 v1.5 padding.");
      error.length = m.length;
      error.max = k - 11;
      throw error;
    }
    eb.putByte(0);
    eb.putByte(bt);
    var padNum = k - 3 - m.length;
    var padByte;
    if (bt === 0 || bt === 1) {
      padByte = bt === 0 ? 0 : 255;
      for (var i = 0; i < padNum; ++i) {
        eb.putByte(padByte);
      }
    } else {
      while (padNum > 0) {
        var numZeros = 0;
        var padBytes = forge2.random.getBytes(padNum);
        for (var i = 0; i < padNum; ++i) {
          padByte = padBytes.charCodeAt(i);
          if (padByte === 0) {
            ++numZeros;
          } else {
            eb.putByte(padByte);
          }
        }
        padNum = numZeros;
      }
    }
    eb.putByte(0);
    eb.putBytes(m);
    return eb;
  }
  function _decodePkcs1_v1_5(em, key, pub, ml, options) {
    var k = Math.ceil(key.n.bitLength() / 8);
    var eb = forge2.util.createBuffer(em);
    var first = eb.getByte();
    var bt = eb.getByte();
    if (first !== 0 || pub && bt !== 0 && bt !== 1 || !pub && bt !== 2 || pub && bt === 0 && typeof ml === "undefined") {
      throw new Error("Encryption block is invalid.");
    }
    var padNum = 0;
    if (bt === 0) {
      padNum = k - 3 - ml;
      for (var i = 0; i < padNum; ++i) {
        if (eb.getByte() !== 0) {
          throw new Error("Encryption block is invalid.");
        }
      }
    } else if (bt === 1) {
      padNum = 0;
      while (eb.length() > 1) {
        if (eb.getByte() !== 255) {
          --eb.read;
          break;
        }
        ++padNum;
      }
      if (padNum < 8 && !(options ? options._skipPaddingChecks : false)) {
        throw new Error("Encryption block is invalid.");
      }
    } else if (bt === 2) {
      padNum = 0;
      while (eb.length() > 1) {
        if (eb.getByte() === 0) {
          --eb.read;
          break;
        }
        ++padNum;
      }
      if (padNum < 8 && !(options ? options._skipPaddingChecks : false)) {
        throw new Error("Encryption block is invalid.");
      }
    }
    var zero = eb.getByte();
    if (zero !== 0 || padNum !== k - 3 - eb.length()) {
      throw new Error("Encryption block is invalid.");
    }
    return eb.getBytes();
  }
  function _generateKeyPair(state, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    options = options || {};
    var opts = {
      algorithm: {
        name: options.algorithm || "PRIMEINC",
        options: {
          workers: options.workers || 2,
          workLoad: options.workLoad || 100,
          workerScript: options.workerScript
        }
      }
    };
    if ("prng" in options) {
      opts.prng = options.prng;
    }
    generate();
    function generate() {
      getPrime(state.pBits, function(err, num) {
        if (err) {
          return callback(err);
        }
        state.p = num;
        if (state.q !== null) {
          return finish(err, state.q);
        }
        getPrime(state.qBits, finish);
      });
    }
    function getPrime(bits, callback2) {
      forge2.prime.generateProbablePrime(bits, opts, callback2);
    }
    function finish(err, num) {
      if (err) {
        return callback(err);
      }
      state.q = num;
      if (state.p.compareTo(state.q) < 0) {
        var tmp = state.p;
        state.p = state.q;
        state.q = tmp;
      }
      if (state.p.subtract(BigInteger.ONE).gcd(state.e).compareTo(BigInteger.ONE) !== 0) {
        state.p = null;
        generate();
        return;
      }
      if (state.q.subtract(BigInteger.ONE).gcd(state.e).compareTo(BigInteger.ONE) !== 0) {
        state.q = null;
        getPrime(state.qBits, finish);
        return;
      }
      state.p1 = state.p.subtract(BigInteger.ONE);
      state.q1 = state.q.subtract(BigInteger.ONE);
      state.phi = state.p1.multiply(state.q1);
      if (state.phi.gcd(state.e).compareTo(BigInteger.ONE) !== 0) {
        state.p = state.q = null;
        generate();
        return;
      }
      state.n = state.p.multiply(state.q);
      if (state.n.bitLength() !== state.bits) {
        state.q = null;
        getPrime(state.qBits, finish);
        return;
      }
      var d = state.e.modInverse(state.phi);
      state.keys = {
        privateKey: pki2.rsa.setPrivateKey(
          state.n,
          state.e,
          d,
          state.p,
          state.q,
          d.mod(state.p1),
          d.mod(state.q1),
          state.q.modInverse(state.p)
        ),
        publicKey: pki2.rsa.setPublicKey(state.n, state.e)
      };
      callback(null, state.keys);
    }
  }
  function _bnToBytes(b) {
    var hex = b.toString(16);
    if (hex[0] >= "8") {
      hex = "00" + hex;
    }
    var bytes = forge2.util.hexToBytes(hex);
    if (bytes.length > 1 && // leading 0x00 for positive integer
    (bytes.charCodeAt(0) === 0 && (bytes.charCodeAt(1) & 128) === 0 || // leading 0xFF for negative integer
    bytes.charCodeAt(0) === 255 && (bytes.charCodeAt(1) & 128) === 128)) {
      return bytes.substr(1);
    }
    return bytes;
  }
  function _getMillerRabinTests(bits) {
    if (bits <= 100) return 27;
    if (bits <= 150) return 18;
    if (bits <= 200) return 15;
    if (bits <= 250) return 12;
    if (bits <= 300) return 9;
    if (bits <= 350) return 8;
    if (bits <= 400) return 7;
    if (bits <= 500) return 6;
    if (bits <= 600) return 5;
    if (bits <= 800) return 4;
    if (bits <= 1250) return 3;
    return 2;
  }
  function _detectNodeCrypto(fn) {
    return forge2.util.isNodejs && typeof _crypto[fn] === "function";
  }
  function _detectSubtleCrypto(fn) {
    return typeof util2.globalScope !== "undefined" && typeof util2.globalScope.crypto === "object" && typeof util2.globalScope.crypto.subtle === "object" && typeof util2.globalScope.crypto.subtle[fn] === "function";
  }
  function _detectSubtleMsCrypto(fn) {
    return typeof util2.globalScope !== "undefined" && typeof util2.globalScope.msCrypto === "object" && typeof util2.globalScope.msCrypto.subtle === "object" && typeof util2.globalScope.msCrypto.subtle[fn] === "function";
  }
  function _intToUint8Array(x) {
    var bytes = forge2.util.hexToBytes(x.toString(16));
    var buffer = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; ++i) {
      buffer[i] = bytes.charCodeAt(i);
    }
    return buffer;
  }
  return rsa;
}
var pbe;
var hasRequiredPbe;
function requirePbe() {
  if (hasRequiredPbe) return pbe;
  hasRequiredPbe = 1;
  var forge2 = requireForge();
  requireAes();
  requireAsn1();
  requireDes();
  requireMd();
  requireOids();
  requirePbkdf2();
  requirePem();
  requireRandom();
  requireRc2();
  requireRsa();
  requireUtil();
  if (typeof BigInteger === "undefined") {
    var BigInteger = forge2.jsbn.BigInteger;
  }
  var asn12 = forge2.asn1;
  var pki2 = forge2.pki = forge2.pki || {};
  pbe = pki2.pbe = forge2.pbe = forge2.pbe || {};
  var oids2 = pki2.oids;
  var encryptedPrivateKeyValidator = {
    name: "EncryptedPrivateKeyInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "EncryptedPrivateKeyInfo.encryptionAlgorithm",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "AlgorithmIdentifier.algorithm",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "encryptionOid"
      }, {
        name: "AlgorithmIdentifier.parameters",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SEQUENCE,
        constructed: true,
        captureAsn1: "encryptionParams"
      }]
    }, {
      // encryptedData
      name: "EncryptedPrivateKeyInfo.encryptedData",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OCTETSTRING,
      constructed: false,
      capture: "encryptedData"
    }]
  };
  var PBES2AlgorithmsValidator = {
    name: "PBES2Algorithms",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "PBES2Algorithms.keyDerivationFunc",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "PBES2Algorithms.keyDerivationFunc.oid",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "kdfOid"
      }, {
        name: "PBES2Algorithms.params",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SEQUENCE,
        constructed: true,
        value: [{
          name: "PBES2Algorithms.params.salt",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.OCTETSTRING,
          constructed: false,
          capture: "kdfSalt"
        }, {
          name: "PBES2Algorithms.params.iterationCount",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.INTEGER,
          constructed: false,
          capture: "kdfIterationCount"
        }, {
          name: "PBES2Algorithms.params.keyLength",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.INTEGER,
          constructed: false,
          optional: true,
          capture: "keyLength"
        }, {
          // prf
          name: "PBES2Algorithms.params.prf",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.SEQUENCE,
          constructed: true,
          optional: true,
          value: [{
            name: "PBES2Algorithms.params.prf.algorithm",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.OID,
            constructed: false,
            capture: "prfOid"
          }]
        }]
      }]
    }, {
      name: "PBES2Algorithms.encryptionScheme",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "PBES2Algorithms.encryptionScheme.oid",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "encOid"
      }, {
        name: "PBES2Algorithms.encryptionScheme.iv",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OCTETSTRING,
        constructed: false,
        capture: "encIv"
      }]
    }]
  };
  var pkcs12PbeParamsValidator = {
    name: "pkcs-12PbeParams",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "pkcs-12PbeParams.salt",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OCTETSTRING,
      constructed: false,
      capture: "salt"
    }, {
      name: "pkcs-12PbeParams.iterations",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "iterations"
    }]
  };
  pki2.encryptPrivateKeyInfo = function(obj, password, options) {
    options = options || {};
    options.saltSize = options.saltSize || 8;
    options.count = options.count || 2048;
    options.algorithm = options.algorithm || "aes128";
    options.prfAlgorithm = options.prfAlgorithm || "sha1";
    var salt = forge2.random.getBytesSync(options.saltSize);
    var count = options.count;
    var countBytes = asn12.integerToDer(count);
    var dkLen;
    var encryptionAlgorithm;
    var encryptedData;
    if (options.algorithm.indexOf("aes") === 0 || options.algorithm === "des") {
      var ivLen, encOid, cipherFn;
      switch (options.algorithm) {
        case "aes128":
          dkLen = 16;
          ivLen = 16;
          encOid = oids2["aes128-CBC"];
          cipherFn = forge2.aes.createEncryptionCipher;
          break;
        case "aes192":
          dkLen = 24;
          ivLen = 16;
          encOid = oids2["aes192-CBC"];
          cipherFn = forge2.aes.createEncryptionCipher;
          break;
        case "aes256":
          dkLen = 32;
          ivLen = 16;
          encOid = oids2["aes256-CBC"];
          cipherFn = forge2.aes.createEncryptionCipher;
          break;
        case "des":
          dkLen = 8;
          ivLen = 8;
          encOid = oids2["desCBC"];
          cipherFn = forge2.des.createEncryptionCipher;
          break;
        default:
          var error = new Error("Cannot encrypt private key. Unknown encryption algorithm.");
          error.algorithm = options.algorithm;
          throw error;
      }
      var prfAlgorithm = "hmacWith" + options.prfAlgorithm.toUpperCase();
      var md2 = prfAlgorithmToMessageDigest(prfAlgorithm);
      var dk = forge2.pkcs5.pbkdf2(password, salt, count, dkLen, md2);
      var iv = forge2.random.getBytesSync(ivLen);
      var cipher2 = cipherFn(dk);
      cipher2.start(iv);
      cipher2.update(asn12.toDer(obj));
      cipher2.finish();
      encryptedData = cipher2.output.getBytes();
      var params = createPbkdf2Params(salt, countBytes, dkLen, prfAlgorithm);
      encryptionAlgorithm = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.SEQUENCE,
        true,
        [
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(oids2["pkcs5PBES2"]).getBytes()
          ),
          asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
            // keyDerivationFunc
            asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.OID,
                false,
                asn12.oidToDer(oids2["pkcs5PBKDF2"]).getBytes()
              ),
              // PBKDF2-params
              params
            ]),
            // encryptionScheme
            asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.OID,
                false,
                asn12.oidToDer(encOid).getBytes()
              ),
              // iv
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.OCTETSTRING,
                false,
                iv
              )
            ])
          ])
        ]
      );
    } else if (options.algorithm === "3des") {
      dkLen = 24;
      var saltBytes = new forge2.util.ByteBuffer(salt);
      var dk = pki2.pbe.generatePkcs12Key(password, saltBytes, 1, count, dkLen);
      var iv = pki2.pbe.generatePkcs12Key(password, saltBytes, 2, count, dkLen);
      var cipher2 = forge2.des.createEncryptionCipher(dk);
      cipher2.start(iv);
      cipher2.update(asn12.toDer(obj));
      cipher2.finish();
      encryptedData = cipher2.output.getBytes();
      encryptionAlgorithm = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.SEQUENCE,
        true,
        [
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(oids2["pbeWithSHAAnd3-KeyTripleDES-CBC"]).getBytes()
          ),
          // pkcs-12PbeParams
          asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
            // salt
            asn12.create(asn12.Class.UNIVERSAL, asn12.Type.OCTETSTRING, false, salt),
            // iteration count
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.INTEGER,
              false,
              countBytes.getBytes()
            )
          ])
        ]
      );
    } else {
      var error = new Error("Cannot encrypt private key. Unknown encryption algorithm.");
      error.algorithm = options.algorithm;
      throw error;
    }
    var rval = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // encryptionAlgorithm
      encryptionAlgorithm,
      // encryptedData
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OCTETSTRING,
        false,
        encryptedData
      )
    ]);
    return rval;
  };
  pki2.decryptPrivateKeyInfo = function(obj, password) {
    var rval = null;
    var capture = {};
    var errors = [];
    if (!asn12.validate(obj, encryptedPrivateKeyValidator, capture, errors)) {
      var error = new Error("Cannot read encrypted private key. ASN.1 object is not a supported EncryptedPrivateKeyInfo.");
      error.errors = errors;
      throw error;
    }
    var oid = asn12.derToOid(capture.encryptionOid);
    var cipher2 = pki2.pbe.getCipher(oid, capture.encryptionParams, password);
    var encrypted = forge2.util.createBuffer(capture.encryptedData);
    cipher2.update(encrypted);
    if (cipher2.finish()) {
      rval = asn12.fromDer(cipher2.output);
    }
    return rval;
  };
  pki2.encryptedPrivateKeyToPem = function(epki, maxline) {
    var msg = {
      type: "ENCRYPTED PRIVATE KEY",
      body: asn12.toDer(epki).getBytes()
    };
    return forge2.pem.encode(msg, { maxline });
  };
  pki2.encryptedPrivateKeyFromPem = function(pem2) {
    var msg = forge2.pem.decode(pem2)[0];
    if (msg.type !== "ENCRYPTED PRIVATE KEY") {
      var error = new Error('Could not convert encrypted private key from PEM; PEM header type is "ENCRYPTED PRIVATE KEY".');
      error.headerType = msg.type;
      throw error;
    }
    if (msg.procType && msg.procType.type === "ENCRYPTED") {
      throw new Error("Could not convert encrypted private key from PEM; PEM is encrypted.");
    }
    return asn12.fromDer(msg.body);
  };
  pki2.encryptRsaPrivateKey = function(rsaKey, password, options) {
    options = options || {};
    if (!options.legacy) {
      var rval = pki2.wrapRsaPrivateKey(pki2.privateKeyToAsn1(rsaKey));
      rval = pki2.encryptPrivateKeyInfo(rval, password, options);
      return pki2.encryptedPrivateKeyToPem(rval);
    }
    var algorithm;
    var iv;
    var dkLen;
    var cipherFn;
    switch (options.algorithm) {
      case "aes128":
        algorithm = "AES-128-CBC";
        dkLen = 16;
        iv = forge2.random.getBytesSync(16);
        cipherFn = forge2.aes.createEncryptionCipher;
        break;
      case "aes192":
        algorithm = "AES-192-CBC";
        dkLen = 24;
        iv = forge2.random.getBytesSync(16);
        cipherFn = forge2.aes.createEncryptionCipher;
        break;
      case "aes256":
        algorithm = "AES-256-CBC";
        dkLen = 32;
        iv = forge2.random.getBytesSync(16);
        cipherFn = forge2.aes.createEncryptionCipher;
        break;
      case "3des":
        algorithm = "DES-EDE3-CBC";
        dkLen = 24;
        iv = forge2.random.getBytesSync(8);
        cipherFn = forge2.des.createEncryptionCipher;
        break;
      case "des":
        algorithm = "DES-CBC";
        dkLen = 8;
        iv = forge2.random.getBytesSync(8);
        cipherFn = forge2.des.createEncryptionCipher;
        break;
      default:
        var error = new Error('Could not encrypt RSA private key; unsupported encryption algorithm "' + options.algorithm + '".');
        error.algorithm = options.algorithm;
        throw error;
    }
    var dk = forge2.pbe.opensslDeriveBytes(password, iv.substr(0, 8), dkLen);
    var cipher2 = cipherFn(dk);
    cipher2.start(iv);
    cipher2.update(asn12.toDer(pki2.privateKeyToAsn1(rsaKey)));
    cipher2.finish();
    var msg = {
      type: "RSA PRIVATE KEY",
      procType: {
        version: "4",
        type: "ENCRYPTED"
      },
      dekInfo: {
        algorithm,
        parameters: forge2.util.bytesToHex(iv).toUpperCase()
      },
      body: cipher2.output.getBytes()
    };
    return forge2.pem.encode(msg);
  };
  pki2.decryptRsaPrivateKey = function(pem2, password) {
    var rval = null;
    var msg = forge2.pem.decode(pem2)[0];
    if (msg.type !== "ENCRYPTED PRIVATE KEY" && msg.type !== "PRIVATE KEY" && msg.type !== "RSA PRIVATE KEY") {
      var error = new Error('Could not convert private key from PEM; PEM header type is not "ENCRYPTED PRIVATE KEY", "PRIVATE KEY", or "RSA PRIVATE KEY".');
      error.headerType = error;
      throw error;
    }
    if (msg.procType && msg.procType.type === "ENCRYPTED") {
      var dkLen;
      var cipherFn;
      switch (msg.dekInfo.algorithm) {
        case "DES-CBC":
          dkLen = 8;
          cipherFn = forge2.des.createDecryptionCipher;
          break;
        case "DES-EDE3-CBC":
          dkLen = 24;
          cipherFn = forge2.des.createDecryptionCipher;
          break;
        case "AES-128-CBC":
          dkLen = 16;
          cipherFn = forge2.aes.createDecryptionCipher;
          break;
        case "AES-192-CBC":
          dkLen = 24;
          cipherFn = forge2.aes.createDecryptionCipher;
          break;
        case "AES-256-CBC":
          dkLen = 32;
          cipherFn = forge2.aes.createDecryptionCipher;
          break;
        case "RC2-40-CBC":
          dkLen = 5;
          cipherFn = function(key) {
            return forge2.rc2.createDecryptionCipher(key, 40);
          };
          break;
        case "RC2-64-CBC":
          dkLen = 8;
          cipherFn = function(key) {
            return forge2.rc2.createDecryptionCipher(key, 64);
          };
          break;
        case "RC2-128-CBC":
          dkLen = 16;
          cipherFn = function(key) {
            return forge2.rc2.createDecryptionCipher(key, 128);
          };
          break;
        default:
          var error = new Error('Could not decrypt private key; unsupported encryption algorithm "' + msg.dekInfo.algorithm + '".');
          error.algorithm = msg.dekInfo.algorithm;
          throw error;
      }
      var iv = forge2.util.hexToBytes(msg.dekInfo.parameters);
      var dk = forge2.pbe.opensslDeriveBytes(password, iv.substr(0, 8), dkLen);
      var cipher2 = cipherFn(dk);
      cipher2.start(iv);
      cipher2.update(forge2.util.createBuffer(msg.body));
      if (cipher2.finish()) {
        rval = cipher2.output.getBytes();
      } else {
        return rval;
      }
    } else {
      rval = msg.body;
    }
    if (msg.type === "ENCRYPTED PRIVATE KEY") {
      rval = pki2.decryptPrivateKeyInfo(asn12.fromDer(rval), password);
    } else {
      rval = asn12.fromDer(rval);
    }
    if (rval !== null) {
      rval = pki2.privateKeyFromAsn1(rval);
    }
    return rval;
  };
  pki2.pbe.generatePkcs12Key = function(password, salt, id, iter, n, md2) {
    var j, l;
    if (typeof md2 === "undefined" || md2 === null) {
      if (!("sha1" in forge2.md)) {
        throw new Error('"sha1" hash algorithm unavailable.');
      }
      md2 = forge2.md.sha1.create();
    }
    var u = md2.digestLength;
    var v = md2.blockLength;
    var result = new forge2.util.ByteBuffer();
    var passBuf = new forge2.util.ByteBuffer();
    if (password !== null && password !== void 0) {
      for (l = 0; l < password.length; l++) {
        passBuf.putInt16(password.charCodeAt(l));
      }
      passBuf.putInt16(0);
    }
    var p = passBuf.length();
    var s = salt.length();
    var D = new forge2.util.ByteBuffer();
    D.fillWithByte(id, v);
    var Slen = v * Math.ceil(s / v);
    var S = new forge2.util.ByteBuffer();
    for (l = 0; l < Slen; l++) {
      S.putByte(salt.at(l % s));
    }
    var Plen = v * Math.ceil(p / v);
    var P = new forge2.util.ByteBuffer();
    for (l = 0; l < Plen; l++) {
      P.putByte(passBuf.at(l % p));
    }
    var I = S;
    I.putBuffer(P);
    var c = Math.ceil(n / u);
    for (var i = 1; i <= c; i++) {
      var buf = new forge2.util.ByteBuffer();
      buf.putBytes(D.bytes());
      buf.putBytes(I.bytes());
      for (var round = 0; round < iter; round++) {
        md2.start();
        md2.update(buf.getBytes());
        buf = md2.digest();
      }
      var B = new forge2.util.ByteBuffer();
      for (l = 0; l < v; l++) {
        B.putByte(buf.at(l % u));
      }
      var k = Math.ceil(s / v) + Math.ceil(p / v);
      var Inew = new forge2.util.ByteBuffer();
      for (j = 0; j < k; j++) {
        var chunk = new forge2.util.ByteBuffer(I.getBytes(v));
        var x = 511;
        for (l = B.length() - 1; l >= 0; l--) {
          x = x >> 8;
          x += B.at(l) + chunk.at(l);
          chunk.setAt(l, x & 255);
        }
        Inew.putBuffer(chunk);
      }
      I = Inew;
      result.putBuffer(buf);
    }
    result.truncate(result.length() - n);
    return result;
  };
  pki2.pbe.getCipher = function(oid, params, password) {
    switch (oid) {
      case pki2.oids["pkcs5PBES2"]:
        return pki2.pbe.getCipherForPBES2(oid, params, password);
      case pki2.oids["pbeWithSHAAnd3-KeyTripleDES-CBC"]:
      case pki2.oids["pbewithSHAAnd40BitRC2-CBC"]:
        return pki2.pbe.getCipherForPKCS12PBE(oid, params, password);
      default:
        var error = new Error("Cannot read encrypted PBE data block. Unsupported OID.");
        error.oid = oid;
        error.supportedOids = [
          "pkcs5PBES2",
          "pbeWithSHAAnd3-KeyTripleDES-CBC",
          "pbewithSHAAnd40BitRC2-CBC"
        ];
        throw error;
    }
  };
  pki2.pbe.getCipherForPBES2 = function(oid, params, password) {
    var capture = {};
    var errors = [];
    if (!asn12.validate(params, PBES2AlgorithmsValidator, capture, errors)) {
      var error = new Error("Cannot read password-based-encryption algorithm parameters. ASN.1 object is not a supported EncryptedPrivateKeyInfo.");
      error.errors = errors;
      throw error;
    }
    oid = asn12.derToOid(capture.kdfOid);
    if (oid !== pki2.oids["pkcs5PBKDF2"]) {
      var error = new Error("Cannot read encrypted private key. Unsupported key derivation function OID.");
      error.oid = oid;
      error.supportedOids = ["pkcs5PBKDF2"];
      throw error;
    }
    oid = asn12.derToOid(capture.encOid);
    if (oid !== pki2.oids["aes128-CBC"] && oid !== pki2.oids["aes192-CBC"] && oid !== pki2.oids["aes256-CBC"] && oid !== pki2.oids["des-EDE3-CBC"] && oid !== pki2.oids["desCBC"]) {
      var error = new Error("Cannot read encrypted private key. Unsupported encryption scheme OID.");
      error.oid = oid;
      error.supportedOids = [
        "aes128-CBC",
        "aes192-CBC",
        "aes256-CBC",
        "des-EDE3-CBC",
        "desCBC"
      ];
      throw error;
    }
    var salt = capture.kdfSalt;
    var count = forge2.util.createBuffer(capture.kdfIterationCount);
    count = count.getInt(count.length() << 3);
    var dkLen;
    var cipherFn;
    switch (pki2.oids[oid]) {
      case "aes128-CBC":
        dkLen = 16;
        cipherFn = forge2.aes.createDecryptionCipher;
        break;
      case "aes192-CBC":
        dkLen = 24;
        cipherFn = forge2.aes.createDecryptionCipher;
        break;
      case "aes256-CBC":
        dkLen = 32;
        cipherFn = forge2.aes.createDecryptionCipher;
        break;
      case "des-EDE3-CBC":
        dkLen = 24;
        cipherFn = forge2.des.createDecryptionCipher;
        break;
      case "desCBC":
        dkLen = 8;
        cipherFn = forge2.des.createDecryptionCipher;
        break;
    }
    var md2 = prfOidToMessageDigest(capture.prfOid);
    var dk = forge2.pkcs5.pbkdf2(password, salt, count, dkLen, md2);
    var iv = capture.encIv;
    var cipher2 = cipherFn(dk);
    cipher2.start(iv);
    return cipher2;
  };
  pki2.pbe.getCipherForPKCS12PBE = function(oid, params, password) {
    var capture = {};
    var errors = [];
    if (!asn12.validate(params, pkcs12PbeParamsValidator, capture, errors)) {
      var error = new Error("Cannot read password-based-encryption algorithm parameters. ASN.1 object is not a supported EncryptedPrivateKeyInfo.");
      error.errors = errors;
      throw error;
    }
    var salt = forge2.util.createBuffer(capture.salt);
    var count = forge2.util.createBuffer(capture.iterations);
    count = count.getInt(count.length() << 3);
    var dkLen, dIvLen, cipherFn;
    switch (oid) {
      case pki2.oids["pbeWithSHAAnd3-KeyTripleDES-CBC"]:
        dkLen = 24;
        dIvLen = 8;
        cipherFn = forge2.des.startDecrypting;
        break;
      case pki2.oids["pbewithSHAAnd40BitRC2-CBC"]:
        dkLen = 5;
        dIvLen = 8;
        cipherFn = function(key2, iv2) {
          var cipher2 = forge2.rc2.createDecryptionCipher(key2, 40);
          cipher2.start(iv2, null);
          return cipher2;
        };
        break;
      default:
        var error = new Error("Cannot read PKCS #12 PBE data block. Unsupported OID.");
        error.oid = oid;
        throw error;
    }
    var md2 = prfOidToMessageDigest(capture.prfOid);
    var key = pki2.pbe.generatePkcs12Key(password, salt, 1, count, dkLen, md2);
    md2.start();
    var iv = pki2.pbe.generatePkcs12Key(password, salt, 2, count, dIvLen, md2);
    return cipherFn(key, iv);
  };
  pki2.pbe.opensslDeriveBytes = function(password, salt, dkLen, md2) {
    if (typeof md2 === "undefined" || md2 === null) {
      if (!("md5" in forge2.md)) {
        throw new Error('"md5" hash algorithm unavailable.');
      }
      md2 = forge2.md.md5.create();
    }
    if (salt === null) {
      salt = "";
    }
    var digests = [hash(md2, password + salt)];
    for (var length = 16, i = 1; length < dkLen; ++i, length += 16) {
      digests.push(hash(md2, digests[i - 1] + password + salt));
    }
    return digests.join("").substr(0, dkLen);
  };
  function hash(md2, bytes) {
    return md2.start().update(bytes).digest().getBytes();
  }
  function prfOidToMessageDigest(prfOid) {
    var prfAlgorithm;
    if (!prfOid) {
      prfAlgorithm = "hmacWithSHA1";
    } else {
      prfAlgorithm = pki2.oids[asn12.derToOid(prfOid)];
      if (!prfAlgorithm) {
        var error = new Error("Unsupported PRF OID.");
        error.oid = prfOid;
        error.supported = [
          "hmacWithSHA1",
          "hmacWithSHA224",
          "hmacWithSHA256",
          "hmacWithSHA384",
          "hmacWithSHA512"
        ];
        throw error;
      }
    }
    return prfAlgorithmToMessageDigest(prfAlgorithm);
  }
  function prfAlgorithmToMessageDigest(prfAlgorithm) {
    var factory = forge2.md;
    switch (prfAlgorithm) {
      case "hmacWithSHA224":
        factory = forge2.md.sha512;
      case "hmacWithSHA1":
      case "hmacWithSHA256":
      case "hmacWithSHA384":
      case "hmacWithSHA512":
        prfAlgorithm = prfAlgorithm.substr(8).toLowerCase();
        break;
      default:
        var error = new Error("Unsupported PRF algorithm.");
        error.algorithm = prfAlgorithm;
        error.supported = [
          "hmacWithSHA1",
          "hmacWithSHA224",
          "hmacWithSHA256",
          "hmacWithSHA384",
          "hmacWithSHA512"
        ];
        throw error;
    }
    if (!factory || !(prfAlgorithm in factory)) {
      throw new Error("Unknown hash algorithm: " + prfAlgorithm);
    }
    return factory[prfAlgorithm].create();
  }
  function createPbkdf2Params(salt, countBytes, dkLen, prfAlgorithm) {
    var params = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // salt
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OCTETSTRING,
        false,
        salt
      ),
      // iteration count
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        countBytes.getBytes()
      )
    ]);
    if (prfAlgorithm !== "hmacWithSHA1") {
      params.value.push(
        // key length
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.INTEGER,
          false,
          forge2.util.hexToBytes(dkLen.toString(16))
        ),
        // AlgorithmIdentifier
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // algorithm
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(pki2.oids[prfAlgorithm]).getBytes()
          ),
          // parameters (null)
          asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
        ])
      );
    }
    return params;
  }
  return pbe;
}
var pkcs12 = { exports: {} };
var pkcs7asn1 = { exports: {} };
var hasRequiredPkcs7asn1;
function requirePkcs7asn1() {
  if (hasRequiredPkcs7asn1) return pkcs7asn1.exports;
  hasRequiredPkcs7asn1 = 1;
  var forge2 = requireForge();
  requireAsn1();
  requireUtil();
  var asn12 = forge2.asn1;
  var p7v = pkcs7asn1.exports = forge2.pkcs7asn1 = forge2.pkcs7asn1 || {};
  forge2.pkcs7 = forge2.pkcs7 || {};
  forge2.pkcs7.asn1 = p7v;
  var contentInfoValidator = {
    name: "ContentInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "ContentInfo.ContentType",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OID,
      constructed: false,
      capture: "contentType"
    }, {
      name: "ContentInfo.content",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      type: 0,
      constructed: true,
      optional: true,
      captureAsn1: "content"
    }]
  };
  p7v.contentInfoValidator = contentInfoValidator;
  var encryptedContentInfoValidator = {
    name: "EncryptedContentInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "EncryptedContentInfo.contentType",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OID,
      constructed: false,
      capture: "contentType"
    }, {
      name: "EncryptedContentInfo.contentEncryptionAlgorithm",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "EncryptedContentInfo.contentEncryptionAlgorithm.algorithm",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "encAlgorithm"
      }, {
        name: "EncryptedContentInfo.contentEncryptionAlgorithm.parameter",
        tagClass: asn12.Class.UNIVERSAL,
        captureAsn1: "encParameter"
      }]
    }, {
      name: "EncryptedContentInfo.encryptedContent",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      type: 0,
      /* The PKCS#7 structure output by OpenSSL somewhat differs from what
       * other implementations do generate.
       *
       * OpenSSL generates a structure like this:
       * SEQUENCE {
       *    ...
       *    [0]
       *       26 DA 67 D2 17 9C 45 3C B1 2A A8 59 2F 29 33 38
       *       C3 C3 DF 86 71 74 7A 19 9F 40 D0 29 BE 85 90 45
       *       ...
       * }
       *
       * Whereas other implementations (and this PKCS#7 module) generate:
       * SEQUENCE {
       *    ...
       *    [0] {
       *       OCTET STRING
       *          26 DA 67 D2 17 9C 45 3C B1 2A A8 59 2F 29 33 38
       *          C3 C3 DF 86 71 74 7A 19 9F 40 D0 29 BE 85 90 45
       *          ...
       *    }
       * }
       *
       * In order to support both, we just capture the context specific
       * field here.  The OCTET STRING bit is removed below.
       */
      capture: "encryptedContent",
      captureAsn1: "encryptedContentAsn1"
    }]
  };
  p7v.envelopedDataValidator = {
    name: "EnvelopedData",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "EnvelopedData.Version",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "version"
    }, {
      name: "EnvelopedData.RecipientInfos",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SET,
      constructed: true,
      captureAsn1: "recipientInfos"
    }].concat(encryptedContentInfoValidator)
  };
  p7v.encryptedDataValidator = {
    name: "EncryptedData",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "EncryptedData.Version",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "version"
    }].concat(encryptedContentInfoValidator)
  };
  var signerValidator = {
    name: "SignerInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "SignerInfo.version",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false
    }, {
      name: "SignerInfo.issuerAndSerialNumber",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "SignerInfo.issuerAndSerialNumber.issuer",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SEQUENCE,
        constructed: true,
        captureAsn1: "issuer"
      }, {
        name: "SignerInfo.issuerAndSerialNumber.serialNumber",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.INTEGER,
        constructed: false,
        capture: "serial"
      }]
    }, {
      name: "SignerInfo.digestAlgorithm",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "SignerInfo.digestAlgorithm.algorithm",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "digestAlgorithm"
      }, {
        name: "SignerInfo.digestAlgorithm.parameter",
        tagClass: asn12.Class.UNIVERSAL,
        constructed: false,
        captureAsn1: "digestParameter",
        optional: true
      }]
    }, {
      name: "SignerInfo.authenticatedAttributes",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      type: 0,
      constructed: true,
      optional: true,
      capture: "authenticatedAttributes"
    }, {
      name: "SignerInfo.digestEncryptionAlgorithm",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      capture: "signatureAlgorithm"
    }, {
      name: "SignerInfo.encryptedDigest",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OCTETSTRING,
      constructed: false,
      capture: "signature"
    }, {
      name: "SignerInfo.unauthenticatedAttributes",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      type: 1,
      constructed: true,
      optional: true,
      capture: "unauthenticatedAttributes"
    }]
  };
  p7v.signedDataValidator = {
    name: "SignedData",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [
      {
        name: "SignedData.Version",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.INTEGER,
        constructed: false,
        capture: "version"
      },
      {
        name: "SignedData.DigestAlgorithms",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SET,
        constructed: true,
        captureAsn1: "digestAlgorithms"
      },
      contentInfoValidator,
      {
        name: "SignedData.Certificates",
        tagClass: asn12.Class.CONTEXT_SPECIFIC,
        type: 0,
        optional: true,
        captureAsn1: "certificates"
      },
      {
        name: "SignedData.CertificateRevocationLists",
        tagClass: asn12.Class.CONTEXT_SPECIFIC,
        type: 1,
        optional: true,
        captureAsn1: "crls"
      },
      {
        name: "SignedData.SignerInfos",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SET,
        capture: "signerInfos",
        optional: true,
        value: [signerValidator]
      }
    ]
  };
  p7v.recipientInfoValidator = {
    name: "RecipientInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "RecipientInfo.version",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "version"
    }, {
      name: "RecipientInfo.issuerAndSerial",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "RecipientInfo.issuerAndSerial.issuer",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SEQUENCE,
        constructed: true,
        captureAsn1: "issuer"
      }, {
        name: "RecipientInfo.issuerAndSerial.serialNumber",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.INTEGER,
        constructed: false,
        capture: "serial"
      }]
    }, {
      name: "RecipientInfo.keyEncryptionAlgorithm",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "RecipientInfo.keyEncryptionAlgorithm.algorithm",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "encAlgorithm"
      }, {
        name: "RecipientInfo.keyEncryptionAlgorithm.parameter",
        tagClass: asn12.Class.UNIVERSAL,
        constructed: false,
        captureAsn1: "encParameter",
        optional: true
      }]
    }, {
      name: "RecipientInfo.encryptedKey",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OCTETSTRING,
      constructed: false,
      capture: "encKey"
    }]
  };
  return pkcs7asn1.exports;
}
var x509 = { exports: {} };
var mgf1 = { exports: {} };
var hasRequiredMgf1;
function requireMgf1() {
  if (hasRequiredMgf1) return mgf1.exports;
  hasRequiredMgf1 = 1;
  var forge2 = requireForge();
  requireUtil();
  forge2.mgf = forge2.mgf || {};
  var mgf1$1 = mgf1.exports = forge2.mgf.mgf1 = forge2.mgf1 = forge2.mgf1 || {};
  mgf1$1.create = function(md2) {
    var mgf2 = {
      /**
       * Generate mask of specified length.
       *
       * @param {String} seed The seed for mask generation.
       * @param maskLen Number of bytes to generate.
       * @return {String} The generated mask.
       */
      generate: function(seed, maskLen) {
        var t = new forge2.util.ByteBuffer();
        var len = Math.ceil(maskLen / md2.digestLength);
        for (var i = 0; i < len; i++) {
          var c = new forge2.util.ByteBuffer();
          c.putInt32(i);
          md2.start();
          md2.update(seed + c.getBytes());
          t.putBuffer(md2.digest());
        }
        t.truncate(t.length() - maskLen);
        return t.getBytes();
      }
    };
    return mgf2;
  };
  return mgf1.exports;
}
var mgf;
var hasRequiredMgf;
function requireMgf() {
  if (hasRequiredMgf) return mgf;
  hasRequiredMgf = 1;
  var forge2 = requireForge();
  requireMgf1();
  mgf = forge2.mgf = forge2.mgf || {};
  forge2.mgf.mgf1 = forge2.mgf1;
  return mgf;
}
var pss = { exports: {} };
var hasRequiredPss;
function requirePss() {
  if (hasRequiredPss) return pss.exports;
  hasRequiredPss = 1;
  var forge2 = requireForge();
  requireRandom();
  requireUtil();
  var pss$1 = pss.exports = forge2.pss = forge2.pss || {};
  pss$1.create = function(options) {
    if (arguments.length === 3) {
      options = {
        md: arguments[0],
        mgf: arguments[1],
        saltLength: arguments[2]
      };
    }
    var hash = options.md;
    var mgf2 = options.mgf;
    var hLen = hash.digestLength;
    var salt_ = options.salt || null;
    if (typeof salt_ === "string") {
      salt_ = forge2.util.createBuffer(salt_);
    }
    var sLen;
    if ("saltLength" in options) {
      sLen = options.saltLength;
    } else if (salt_ !== null) {
      sLen = salt_.length();
    } else {
      throw new Error("Salt length not specified or specific salt not given.");
    }
    if (salt_ !== null && salt_.length() !== sLen) {
      throw new Error("Given salt length does not match length of given salt.");
    }
    var prng2 = options.prng || forge2.random;
    var pssobj = {};
    pssobj.encode = function(md2, modBits) {
      var i;
      var emBits = modBits - 1;
      var emLen = Math.ceil(emBits / 8);
      var mHash = md2.digest().getBytes();
      if (emLen < hLen + sLen + 2) {
        throw new Error("Message is too long to encrypt.");
      }
      var salt;
      if (salt_ === null) {
        salt = prng2.getBytesSync(sLen);
      } else {
        salt = salt_.bytes();
      }
      var m_ = new forge2.util.ByteBuffer();
      m_.fillWithByte(0, 8);
      m_.putBytes(mHash);
      m_.putBytes(salt);
      hash.start();
      hash.update(m_.getBytes());
      var h = hash.digest().getBytes();
      var ps = new forge2.util.ByteBuffer();
      ps.fillWithByte(0, emLen - sLen - hLen - 2);
      ps.putByte(1);
      ps.putBytes(salt);
      var db = ps.getBytes();
      var maskLen = emLen - hLen - 1;
      var dbMask = mgf2.generate(h, maskLen);
      var maskedDB = "";
      for (i = 0; i < maskLen; i++) {
        maskedDB += String.fromCharCode(db.charCodeAt(i) ^ dbMask.charCodeAt(i));
      }
      var mask = 65280 >> 8 * emLen - emBits & 255;
      maskedDB = String.fromCharCode(maskedDB.charCodeAt(0) & ~mask) + maskedDB.substr(1);
      return maskedDB + h + String.fromCharCode(188);
    };
    pssobj.verify = function(mHash, em, modBits) {
      var i;
      var emBits = modBits - 1;
      var emLen = Math.ceil(emBits / 8);
      em = em.substr(-emLen);
      if (emLen < hLen + sLen + 2) {
        throw new Error("Inconsistent parameters to PSS signature verification.");
      }
      if (em.charCodeAt(emLen - 1) !== 188) {
        throw new Error("Encoded message does not end in 0xBC.");
      }
      var maskLen = emLen - hLen - 1;
      var maskedDB = em.substr(0, maskLen);
      var h = em.substr(maskLen, hLen);
      var mask = 65280 >> 8 * emLen - emBits & 255;
      if ((maskedDB.charCodeAt(0) & mask) !== 0) {
        throw new Error("Bits beyond keysize not zero as expected.");
      }
      var dbMask = mgf2.generate(h, maskLen);
      var db = "";
      for (i = 0; i < maskLen; i++) {
        db += String.fromCharCode(maskedDB.charCodeAt(i) ^ dbMask.charCodeAt(i));
      }
      db = String.fromCharCode(db.charCodeAt(0) & ~mask) + db.substr(1);
      var checkLen = emLen - hLen - sLen - 2;
      for (i = 0; i < checkLen; i++) {
        if (db.charCodeAt(i) !== 0) {
          throw new Error("Leftmost octets not zero as expected");
        }
      }
      if (db.charCodeAt(checkLen) !== 1) {
        throw new Error("Inconsistent PSS signature, 0x01 marker not found");
      }
      var salt = db.substr(-sLen);
      var m_ = new forge2.util.ByteBuffer();
      m_.fillWithByte(0, 8);
      m_.putBytes(mHash);
      m_.putBytes(salt);
      hash.start();
      hash.update(m_.getBytes());
      var h_ = hash.digest().getBytes();
      return h === h_;
    };
    return pssobj;
  };
  return pss.exports;
}
var hasRequiredX509;
function requireX509() {
  if (hasRequiredX509) return x509.exports;
  hasRequiredX509 = 1;
  var forge2 = requireForge();
  requireAes();
  requireAsn1();
  requireDes();
  requireMd();
  requireMgf();
  requireOids();
  requirePem();
  requirePss();
  requireRsa();
  requireUtil();
  var asn12 = forge2.asn1;
  var pki2 = x509.exports = forge2.pki = forge2.pki || {};
  var oids2 = pki2.oids;
  var _shortNames = {};
  _shortNames["CN"] = oids2["commonName"];
  _shortNames["commonName"] = "CN";
  _shortNames["C"] = oids2["countryName"];
  _shortNames["countryName"] = "C";
  _shortNames["L"] = oids2["localityName"];
  _shortNames["localityName"] = "L";
  _shortNames["ST"] = oids2["stateOrProvinceName"];
  _shortNames["stateOrProvinceName"] = "ST";
  _shortNames["O"] = oids2["organizationName"];
  _shortNames["organizationName"] = "O";
  _shortNames["OU"] = oids2["organizationalUnitName"];
  _shortNames["organizationalUnitName"] = "OU";
  _shortNames["E"] = oids2["emailAddress"];
  _shortNames["emailAddress"] = "E";
  var publicKeyValidator = forge2.pki.rsa.publicKeyValidator;
  var x509CertificateValidator = {
    name: "Certificate",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "Certificate.TBSCertificate",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      captureAsn1: "tbsCertificate",
      value: [
        {
          name: "Certificate.TBSCertificate.version",
          tagClass: asn12.Class.CONTEXT_SPECIFIC,
          type: 0,
          constructed: true,
          optional: true,
          value: [{
            name: "Certificate.TBSCertificate.version.integer",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.INTEGER,
            constructed: false,
            capture: "certVersion"
          }]
        },
        {
          name: "Certificate.TBSCertificate.serialNumber",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.INTEGER,
          constructed: false,
          capture: "certSerialNumber"
        },
        {
          name: "Certificate.TBSCertificate.signature",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.SEQUENCE,
          constructed: true,
          value: [{
            name: "Certificate.TBSCertificate.signature.algorithm",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.OID,
            constructed: false,
            capture: "certinfoSignatureOid"
          }, {
            name: "Certificate.TBSCertificate.signature.parameters",
            tagClass: asn12.Class.UNIVERSAL,
            optional: true,
            captureAsn1: "certinfoSignatureParams"
          }]
        },
        {
          name: "Certificate.TBSCertificate.issuer",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.SEQUENCE,
          constructed: true,
          captureAsn1: "certIssuer"
        },
        {
          name: "Certificate.TBSCertificate.validity",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.SEQUENCE,
          constructed: true,
          // Note: UTC and generalized times may both appear so the capture
          // names are based on their detected order, the names used below
          // are only for the common case, which validity time really means
          // "notBefore" and which means "notAfter" will be determined by order
          value: [{
            // notBefore (Time) (UTC time case)
            name: "Certificate.TBSCertificate.validity.notBefore (utc)",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.UTCTIME,
            constructed: false,
            optional: true,
            capture: "certValidity1UTCTime"
          }, {
            // notBefore (Time) (generalized time case)
            name: "Certificate.TBSCertificate.validity.notBefore (generalized)",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.GENERALIZEDTIME,
            constructed: false,
            optional: true,
            capture: "certValidity2GeneralizedTime"
          }, {
            // notAfter (Time) (only UTC time is supported)
            name: "Certificate.TBSCertificate.validity.notAfter (utc)",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.UTCTIME,
            constructed: false,
            optional: true,
            capture: "certValidity3UTCTime"
          }, {
            // notAfter (Time) (only UTC time is supported)
            name: "Certificate.TBSCertificate.validity.notAfter (generalized)",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.GENERALIZEDTIME,
            constructed: false,
            optional: true,
            capture: "certValidity4GeneralizedTime"
          }]
        },
        {
          // Name (subject) (RDNSequence)
          name: "Certificate.TBSCertificate.subject",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.SEQUENCE,
          constructed: true,
          captureAsn1: "certSubject"
        },
        // SubjectPublicKeyInfo
        publicKeyValidator,
        {
          // issuerUniqueID (optional)
          name: "Certificate.TBSCertificate.issuerUniqueID",
          tagClass: asn12.Class.CONTEXT_SPECIFIC,
          type: 1,
          constructed: true,
          optional: true,
          value: [{
            name: "Certificate.TBSCertificate.issuerUniqueID.id",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.BITSTRING,
            constructed: false,
            // TODO: support arbitrary bit length ids
            captureBitStringValue: "certIssuerUniqueId"
          }]
        },
        {
          // subjectUniqueID (optional)
          name: "Certificate.TBSCertificate.subjectUniqueID",
          tagClass: asn12.Class.CONTEXT_SPECIFIC,
          type: 2,
          constructed: true,
          optional: true,
          value: [{
            name: "Certificate.TBSCertificate.subjectUniqueID.id",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.BITSTRING,
            constructed: false,
            // TODO: support arbitrary bit length ids
            captureBitStringValue: "certSubjectUniqueId"
          }]
        },
        {
          // Extensions (optional)
          name: "Certificate.TBSCertificate.extensions",
          tagClass: asn12.Class.CONTEXT_SPECIFIC,
          type: 3,
          constructed: true,
          captureAsn1: "certExtensions",
          optional: true
        }
      ]
    }, {
      // AlgorithmIdentifier (signature algorithm)
      name: "Certificate.signatureAlgorithm",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        // algorithm
        name: "Certificate.signatureAlgorithm.algorithm",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "certSignatureOid"
      }, {
        name: "Certificate.TBSCertificate.signature.parameters",
        tagClass: asn12.Class.UNIVERSAL,
        optional: true,
        captureAsn1: "certSignatureParams"
      }]
    }, {
      // SignatureValue
      name: "Certificate.signatureValue",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.BITSTRING,
      constructed: false,
      captureBitStringValue: "certSignature"
    }]
  };
  var rsassaPssParameterValidator = {
    name: "rsapss",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "rsapss.hashAlgorithm",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      type: 0,
      constructed: true,
      value: [{
        name: "rsapss.hashAlgorithm.AlgorithmIdentifier",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Class.SEQUENCE,
        constructed: true,
        optional: true,
        value: [{
          name: "rsapss.hashAlgorithm.AlgorithmIdentifier.algorithm",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.OID,
          constructed: false,
          capture: "hashOid"
          /* parameter block omitted, for SHA1 NULL anyhow. */
        }]
      }]
    }, {
      name: "rsapss.maskGenAlgorithm",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      type: 1,
      constructed: true,
      value: [{
        name: "rsapss.maskGenAlgorithm.AlgorithmIdentifier",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Class.SEQUENCE,
        constructed: true,
        optional: true,
        value: [{
          name: "rsapss.maskGenAlgorithm.AlgorithmIdentifier.algorithm",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.OID,
          constructed: false,
          capture: "maskGenOid"
        }, {
          name: "rsapss.maskGenAlgorithm.AlgorithmIdentifier.params",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.SEQUENCE,
          constructed: true,
          value: [{
            name: "rsapss.maskGenAlgorithm.AlgorithmIdentifier.params.algorithm",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.OID,
            constructed: false,
            capture: "maskGenHashOid"
            /* parameter block omitted, for SHA1 NULL anyhow. */
          }]
        }]
      }]
    }, {
      name: "rsapss.saltLength",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      type: 2,
      optional: true,
      value: [{
        name: "rsapss.saltLength.saltLength",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Class.INTEGER,
        constructed: false,
        capture: "saltLength"
      }]
    }, {
      name: "rsapss.trailerField",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      type: 3,
      optional: true,
      value: [{
        name: "rsapss.trailer.trailer",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Class.INTEGER,
        constructed: false,
        capture: "trailer"
      }]
    }]
  };
  var certificationRequestInfoValidator = {
    name: "CertificationRequestInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    captureAsn1: "certificationRequestInfo",
    value: [
      {
        name: "CertificationRequestInfo.integer",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.INTEGER,
        constructed: false,
        capture: "certificationRequestInfoVersion"
      },
      {
        // Name (subject) (RDNSequence)
        name: "CertificationRequestInfo.subject",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SEQUENCE,
        constructed: true,
        captureAsn1: "certificationRequestInfoSubject"
      },
      // SubjectPublicKeyInfo
      publicKeyValidator,
      {
        name: "CertificationRequestInfo.attributes",
        tagClass: asn12.Class.CONTEXT_SPECIFIC,
        type: 0,
        constructed: true,
        optional: true,
        capture: "certificationRequestInfoAttributes",
        value: [{
          name: "CertificationRequestInfo.attributes",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.SEQUENCE,
          constructed: true,
          value: [{
            name: "CertificationRequestInfo.attributes.type",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.OID,
            constructed: false
          }, {
            name: "CertificationRequestInfo.attributes.value",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.SET,
            constructed: true
          }]
        }]
      }
    ]
  };
  var certificationRequestValidator = {
    name: "CertificationRequest",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    captureAsn1: "csr",
    value: [
      certificationRequestInfoValidator,
      {
        // AlgorithmIdentifier (signature algorithm)
        name: "CertificationRequest.signatureAlgorithm",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SEQUENCE,
        constructed: true,
        value: [{
          // algorithm
          name: "CertificationRequest.signatureAlgorithm.algorithm",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.OID,
          constructed: false,
          capture: "csrSignatureOid"
        }, {
          name: "CertificationRequest.signatureAlgorithm.parameters",
          tagClass: asn12.Class.UNIVERSAL,
          optional: true,
          captureAsn1: "csrSignatureParams"
        }]
      },
      {
        // signature
        name: "CertificationRequest.signature",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.BITSTRING,
        constructed: false,
        captureBitStringValue: "csrSignature"
      }
    ]
  };
  pki2.RDNAttributesAsArray = function(rdn, md2) {
    var rval = [];
    var set, attr, obj;
    for (var si = 0; si < rdn.value.length; ++si) {
      set = rdn.value[si];
      for (var i = 0; i < set.value.length; ++i) {
        obj = {};
        attr = set.value[i];
        obj.type = asn12.derToOid(attr.value[0].value);
        obj.value = attr.value[1].value;
        obj.valueTagClass = attr.value[1].type;
        if (obj.type in oids2) {
          obj.name = oids2[obj.type];
          if (obj.name in _shortNames) {
            obj.shortName = _shortNames[obj.name];
          }
        }
        if (md2) {
          md2.update(obj.type);
          md2.update(obj.value);
        }
        rval.push(obj);
      }
    }
    return rval;
  };
  pki2.CRIAttributesAsArray = function(attributes) {
    var rval = [];
    for (var si = 0; si < attributes.length; ++si) {
      var seq = attributes[si];
      var type = asn12.derToOid(seq.value[0].value);
      var values = seq.value[1].value;
      for (var vi = 0; vi < values.length; ++vi) {
        var obj = {};
        obj.type = type;
        obj.value = values[vi].value;
        obj.valueTagClass = values[vi].type;
        if (obj.type in oids2) {
          obj.name = oids2[obj.type];
          if (obj.name in _shortNames) {
            obj.shortName = _shortNames[obj.name];
          }
        }
        if (obj.type === oids2.extensionRequest) {
          obj.extensions = [];
          for (var ei = 0; ei < obj.value.length; ++ei) {
            obj.extensions.push(pki2.certificateExtensionFromAsn1(obj.value[ei]));
          }
        }
        rval.push(obj);
      }
    }
    return rval;
  };
  function _getAttribute(obj, options) {
    if (typeof options === "string") {
      options = { shortName: options };
    }
    var rval = null;
    var attr;
    for (var i = 0; rval === null && i < obj.attributes.length; ++i) {
      attr = obj.attributes[i];
      if (options.type && options.type === attr.type) {
        rval = attr;
      } else if (options.name && options.name === attr.name) {
        rval = attr;
      } else if (options.shortName && options.shortName === attr.shortName) {
        rval = attr;
      }
    }
    return rval;
  }
  var _readSignatureParameters = function(oid, obj, fillDefaults) {
    var params = {};
    if (oid !== oids2["RSASSA-PSS"]) {
      return params;
    }
    if (fillDefaults) {
      params = {
        hash: {
          algorithmOid: oids2["sha1"]
        },
        mgf: {
          algorithmOid: oids2["mgf1"],
          hash: {
            algorithmOid: oids2["sha1"]
          }
        },
        saltLength: 20
      };
    }
    var capture = {};
    var errors = [];
    if (!asn12.validate(obj, rsassaPssParameterValidator, capture, errors)) {
      var error = new Error("Cannot read RSASSA-PSS parameter block.");
      error.errors = errors;
      throw error;
    }
    if (capture.hashOid !== void 0) {
      params.hash = params.hash || {};
      params.hash.algorithmOid = asn12.derToOid(capture.hashOid);
    }
    if (capture.maskGenOid !== void 0) {
      params.mgf = params.mgf || {};
      params.mgf.algorithmOid = asn12.derToOid(capture.maskGenOid);
      params.mgf.hash = params.mgf.hash || {};
      params.mgf.hash.algorithmOid = asn12.derToOid(capture.maskGenHashOid);
    }
    if (capture.saltLength !== void 0) {
      params.saltLength = capture.saltLength.charCodeAt(0);
    }
    return params;
  };
  var _createSignatureDigest = function(options) {
    switch (oids2[options.signatureOid]) {
      case "sha1WithRSAEncryption":
      // deprecated alias
      case "sha1WithRSASignature":
        return forge2.md.sha1.create();
      case "md5WithRSAEncryption":
        return forge2.md.md5.create();
      case "sha256WithRSAEncryption":
        return forge2.md.sha256.create();
      case "sha384WithRSAEncryption":
        return forge2.md.sha384.create();
      case "sha512WithRSAEncryption":
        return forge2.md.sha512.create();
      case "RSASSA-PSS":
        return forge2.md.sha256.create();
      default:
        var error = new Error(
          "Could not compute " + options.type + " digest. Unknown signature OID."
        );
        error.signatureOid = options.signatureOid;
        throw error;
    }
  };
  var _verifySignature = function(options) {
    var cert = options.certificate;
    var scheme;
    switch (cert.signatureOid) {
      case oids2.sha1WithRSAEncryption:
      // deprecated alias
      case oids2.sha1WithRSASignature:
        break;
      case oids2["RSASSA-PSS"]:
        var hash, mgf2;
        hash = oids2[cert.signatureParameters.mgf.hash.algorithmOid];
        if (hash === void 0 || forge2.md[hash] === void 0) {
          var error = new Error("Unsupported MGF hash function.");
          error.oid = cert.signatureParameters.mgf.hash.algorithmOid;
          error.name = hash;
          throw error;
        }
        mgf2 = oids2[cert.signatureParameters.mgf.algorithmOid];
        if (mgf2 === void 0 || forge2.mgf[mgf2] === void 0) {
          var error = new Error("Unsupported MGF function.");
          error.oid = cert.signatureParameters.mgf.algorithmOid;
          error.name = mgf2;
          throw error;
        }
        mgf2 = forge2.mgf[mgf2].create(forge2.md[hash].create());
        hash = oids2[cert.signatureParameters.hash.algorithmOid];
        if (hash === void 0 || forge2.md[hash] === void 0) {
          var error = new Error("Unsupported RSASSA-PSS hash function.");
          error.oid = cert.signatureParameters.hash.algorithmOid;
          error.name = hash;
          throw error;
        }
        scheme = forge2.pss.create(
          forge2.md[hash].create(),
          mgf2,
          cert.signatureParameters.saltLength
        );
        break;
    }
    return cert.publicKey.verify(
      options.md.digest().getBytes(),
      options.signature,
      scheme
    );
  };
  pki2.certificateFromPem = function(pem2, computeHash, strict) {
    var msg = forge2.pem.decode(pem2)[0];
    if (msg.type !== "CERTIFICATE" && msg.type !== "X509 CERTIFICATE" && msg.type !== "TRUSTED CERTIFICATE") {
      var error = new Error(
        'Could not convert certificate from PEM; PEM header type is not "CERTIFICATE", "X509 CERTIFICATE", or "TRUSTED CERTIFICATE".'
      );
      error.headerType = msg.type;
      throw error;
    }
    if (msg.procType && msg.procType.type === "ENCRYPTED") {
      throw new Error(
        "Could not convert certificate from PEM; PEM is encrypted."
      );
    }
    var obj = asn12.fromDer(msg.body, strict);
    return pki2.certificateFromAsn1(obj, computeHash);
  };
  pki2.certificateToPem = function(cert, maxline) {
    var msg = {
      type: "CERTIFICATE",
      body: asn12.toDer(pki2.certificateToAsn1(cert)).getBytes()
    };
    return forge2.pem.encode(msg, { maxline });
  };
  pki2.publicKeyFromPem = function(pem2) {
    var msg = forge2.pem.decode(pem2)[0];
    if (msg.type !== "PUBLIC KEY" && msg.type !== "RSA PUBLIC KEY") {
      var error = new Error('Could not convert public key from PEM; PEM header type is not "PUBLIC KEY" or "RSA PUBLIC KEY".');
      error.headerType = msg.type;
      throw error;
    }
    if (msg.procType && msg.procType.type === "ENCRYPTED") {
      throw new Error("Could not convert public key from PEM; PEM is encrypted.");
    }
    var obj = asn12.fromDer(msg.body);
    return pki2.publicKeyFromAsn1(obj);
  };
  pki2.publicKeyToPem = function(key, maxline) {
    var msg = {
      type: "PUBLIC KEY",
      body: asn12.toDer(pki2.publicKeyToAsn1(key)).getBytes()
    };
    return forge2.pem.encode(msg, { maxline });
  };
  pki2.publicKeyToRSAPublicKeyPem = function(key, maxline) {
    var msg = {
      type: "RSA PUBLIC KEY",
      body: asn12.toDer(pki2.publicKeyToRSAPublicKey(key)).getBytes()
    };
    return forge2.pem.encode(msg, { maxline });
  };
  pki2.getPublicKeyFingerprint = function(key, options) {
    options = options || {};
    var md2 = options.md || forge2.md.sha1.create();
    var type = options.type || "RSAPublicKey";
    var bytes;
    switch (type) {
      case "RSAPublicKey":
        bytes = asn12.toDer(pki2.publicKeyToRSAPublicKey(key)).getBytes();
        break;
      case "SubjectPublicKeyInfo":
        bytes = asn12.toDer(pki2.publicKeyToAsn1(key)).getBytes();
        break;
      default:
        throw new Error('Unknown fingerprint type "' + options.type + '".');
    }
    md2.start();
    md2.update(bytes);
    var digest = md2.digest();
    if (options.encoding === "hex") {
      var hex = digest.toHex();
      if (options.delimiter) {
        return hex.match(/.{2}/g).join(options.delimiter);
      }
      return hex;
    } else if (options.encoding === "binary") {
      return digest.getBytes();
    } else if (options.encoding) {
      throw new Error('Unknown encoding "' + options.encoding + '".');
    }
    return digest;
  };
  pki2.certificationRequestFromPem = function(pem2, computeHash, strict) {
    var msg = forge2.pem.decode(pem2)[0];
    if (msg.type !== "CERTIFICATE REQUEST") {
      var error = new Error('Could not convert certification request from PEM; PEM header type is not "CERTIFICATE REQUEST".');
      error.headerType = msg.type;
      throw error;
    }
    if (msg.procType && msg.procType.type === "ENCRYPTED") {
      throw new Error("Could not convert certification request from PEM; PEM is encrypted.");
    }
    var obj = asn12.fromDer(msg.body, strict);
    return pki2.certificationRequestFromAsn1(obj, computeHash);
  };
  pki2.certificationRequestToPem = function(csr, maxline) {
    var msg = {
      type: "CERTIFICATE REQUEST",
      body: asn12.toDer(pki2.certificationRequestToAsn1(csr)).getBytes()
    };
    return forge2.pem.encode(msg, { maxline });
  };
  pki2.createCertificate = function() {
    var cert = {};
    cert.version = 2;
    cert.serialNumber = "00";
    cert.signatureOid = null;
    cert.signature = null;
    cert.siginfo = {};
    cert.siginfo.algorithmOid = null;
    cert.validity = {};
    cert.validity.notBefore = /* @__PURE__ */ new Date();
    cert.validity.notAfter = /* @__PURE__ */ new Date();
    cert.issuer = {};
    cert.issuer.getField = function(sn) {
      return _getAttribute(cert.issuer, sn);
    };
    cert.issuer.addField = function(attr) {
      _fillMissingFields([attr]);
      cert.issuer.attributes.push(attr);
    };
    cert.issuer.attributes = [];
    cert.issuer.hash = null;
    cert.subject = {};
    cert.subject.getField = function(sn) {
      return _getAttribute(cert.subject, sn);
    };
    cert.subject.addField = function(attr) {
      _fillMissingFields([attr]);
      cert.subject.attributes.push(attr);
    };
    cert.subject.attributes = [];
    cert.subject.hash = null;
    cert.extensions = [];
    cert.publicKey = null;
    cert.md = null;
    cert.setSubject = function(attrs, uniqueId) {
      _fillMissingFields(attrs);
      cert.subject.attributes = attrs;
      delete cert.subject.uniqueId;
      if (uniqueId) {
        cert.subject.uniqueId = uniqueId;
      }
      cert.subject.hash = null;
    };
    cert.setIssuer = function(attrs, uniqueId) {
      _fillMissingFields(attrs);
      cert.issuer.attributes = attrs;
      delete cert.issuer.uniqueId;
      if (uniqueId) {
        cert.issuer.uniqueId = uniqueId;
      }
      cert.issuer.hash = null;
    };
    cert.setExtensions = function(exts) {
      for (var i = 0; i < exts.length; ++i) {
        _fillMissingExtensionFields(exts[i], { cert });
      }
      cert.extensions = exts;
    };
    cert.getExtension = function(options) {
      if (typeof options === "string") {
        options = { name: options };
      }
      var rval = null;
      var ext;
      for (var i = 0; rval === null && i < cert.extensions.length; ++i) {
        ext = cert.extensions[i];
        if (options.id && ext.id === options.id) {
          rval = ext;
        } else if (options.name && ext.name === options.name) {
          rval = ext;
        }
      }
      return rval;
    };
    cert.sign = function(key, md2) {
      cert.md = md2 || forge2.md.sha1.create();
      var algorithmOid = oids2[cert.md.algorithm + "WithRSAEncryption"];
      if (!algorithmOid) {
        var error = new Error("Could not compute certificate digest. Unknown message digest algorithm OID.");
        error.algorithm = cert.md.algorithm;
        throw error;
      }
      cert.signatureOid = cert.siginfo.algorithmOid = algorithmOid;
      cert.tbsCertificate = pki2.getTBSCertificate(cert);
      var bytes = asn12.toDer(cert.tbsCertificate);
      cert.md.update(bytes.getBytes());
      cert.signature = key.sign(cert.md);
    };
    cert.verify = function(child) {
      var rval = false;
      if (!cert.issued(child)) {
        var issuer = child.issuer;
        var subject = cert.subject;
        var error = new Error(
          "The parent certificate did not issue the given child certificate; the child certificate's issuer does not match the parent's subject."
        );
        error.expectedIssuer = subject.attributes;
        error.actualIssuer = issuer.attributes;
        throw error;
      }
      var md2 = child.md;
      if (md2 === null) {
        md2 = _createSignatureDigest({
          signatureOid: child.signatureOid,
          type: "certificate"
        });
        var tbsCertificate = child.tbsCertificate || pki2.getTBSCertificate(child);
        var bytes = asn12.toDer(tbsCertificate);
        md2.update(bytes.getBytes());
      }
      if (md2 !== null) {
        rval = _verifySignature({
          certificate: cert,
          md: md2,
          signature: child.signature
        });
      }
      return rval;
    };
    cert.isIssuer = function(parent) {
      var rval = false;
      var i = cert.issuer;
      var s = parent.subject;
      if (i.hash && s.hash) {
        rval = i.hash === s.hash;
      } else if (i.attributes.length === s.attributes.length) {
        rval = true;
        var iattr, sattr;
        for (var n = 0; rval && n < i.attributes.length; ++n) {
          iattr = i.attributes[n];
          sattr = s.attributes[n];
          if (iattr.type !== sattr.type || iattr.value !== sattr.value) {
            rval = false;
          }
        }
      }
      return rval;
    };
    cert.issued = function(child) {
      return child.isIssuer(cert);
    };
    cert.generateSubjectKeyIdentifier = function() {
      return pki2.getPublicKeyFingerprint(cert.publicKey, { type: "RSAPublicKey" });
    };
    cert.verifySubjectKeyIdentifier = function() {
      var oid = oids2["subjectKeyIdentifier"];
      for (var i = 0; i < cert.extensions.length; ++i) {
        var ext = cert.extensions[i];
        if (ext.id === oid) {
          var ski = cert.generateSubjectKeyIdentifier().getBytes();
          return forge2.util.hexToBytes(ext.subjectKeyIdentifier) === ski;
        }
      }
      return false;
    };
    return cert;
  };
  pki2.certificateFromAsn1 = function(obj, computeHash) {
    var capture = {};
    var errors = [];
    if (!asn12.validate(obj, x509CertificateValidator, capture, errors)) {
      var error = new Error("Cannot read X.509 certificate. ASN.1 object is not an X509v3 Certificate.");
      error.errors = errors;
      throw error;
    }
    var oid = asn12.derToOid(capture.publicKeyOid);
    if (oid !== pki2.oids.rsaEncryption) {
      throw new Error("Cannot read public key. OID is not RSA.");
    }
    var cert = pki2.createCertificate();
    cert.version = capture.certVersion ? capture.certVersion.charCodeAt(0) : 0;
    var serial = forge2.util.createBuffer(capture.certSerialNumber);
    cert.serialNumber = serial.toHex();
    cert.signatureOid = forge2.asn1.derToOid(capture.certSignatureOid);
    cert.signatureParameters = _readSignatureParameters(
      cert.signatureOid,
      capture.certSignatureParams,
      true
    );
    cert.siginfo.algorithmOid = forge2.asn1.derToOid(capture.certinfoSignatureOid);
    cert.siginfo.parameters = _readSignatureParameters(
      cert.siginfo.algorithmOid,
      capture.certinfoSignatureParams,
      false
    );
    cert.signature = capture.certSignature;
    var validity = [];
    if (capture.certValidity1UTCTime !== void 0) {
      validity.push(asn12.utcTimeToDate(capture.certValidity1UTCTime));
    }
    if (capture.certValidity2GeneralizedTime !== void 0) {
      validity.push(asn12.generalizedTimeToDate(
        capture.certValidity2GeneralizedTime
      ));
    }
    if (capture.certValidity3UTCTime !== void 0) {
      validity.push(asn12.utcTimeToDate(capture.certValidity3UTCTime));
    }
    if (capture.certValidity4GeneralizedTime !== void 0) {
      validity.push(asn12.generalizedTimeToDate(
        capture.certValidity4GeneralizedTime
      ));
    }
    if (validity.length > 2) {
      throw new Error("Cannot read notBefore/notAfter validity times; more than two times were provided in the certificate.");
    }
    if (validity.length < 2) {
      throw new Error("Cannot read notBefore/notAfter validity times; they were not provided as either UTCTime or GeneralizedTime.");
    }
    cert.validity.notBefore = validity[0];
    cert.validity.notAfter = validity[1];
    cert.tbsCertificate = capture.tbsCertificate;
    if (computeHash) {
      cert.md = _createSignatureDigest({
        signatureOid: cert.signatureOid,
        type: "certificate"
      });
      var bytes = asn12.toDer(cert.tbsCertificate);
      cert.md.update(bytes.getBytes());
    }
    var imd = forge2.md.sha1.create();
    var ibytes = asn12.toDer(capture.certIssuer);
    imd.update(ibytes.getBytes());
    cert.issuer.getField = function(sn) {
      return _getAttribute(cert.issuer, sn);
    };
    cert.issuer.addField = function(attr) {
      _fillMissingFields([attr]);
      cert.issuer.attributes.push(attr);
    };
    cert.issuer.attributes = pki2.RDNAttributesAsArray(capture.certIssuer);
    if (capture.certIssuerUniqueId) {
      cert.issuer.uniqueId = capture.certIssuerUniqueId;
    }
    cert.issuer.hash = imd.digest().toHex();
    var smd = forge2.md.sha1.create();
    var sbytes = asn12.toDer(capture.certSubject);
    smd.update(sbytes.getBytes());
    cert.subject.getField = function(sn) {
      return _getAttribute(cert.subject, sn);
    };
    cert.subject.addField = function(attr) {
      _fillMissingFields([attr]);
      cert.subject.attributes.push(attr);
    };
    cert.subject.attributes = pki2.RDNAttributesAsArray(capture.certSubject);
    if (capture.certSubjectUniqueId) {
      cert.subject.uniqueId = capture.certSubjectUniqueId;
    }
    cert.subject.hash = smd.digest().toHex();
    if (capture.certExtensions) {
      cert.extensions = pki2.certificateExtensionsFromAsn1(capture.certExtensions);
    } else {
      cert.extensions = [];
    }
    cert.publicKey = pki2.publicKeyFromAsn1(capture.subjectPublicKeyInfo);
    return cert;
  };
  pki2.certificateExtensionsFromAsn1 = function(exts) {
    var rval = [];
    for (var i = 0; i < exts.value.length; ++i) {
      var extseq = exts.value[i];
      for (var ei = 0; ei < extseq.value.length; ++ei) {
        rval.push(pki2.certificateExtensionFromAsn1(extseq.value[ei]));
      }
    }
    return rval;
  };
  pki2.certificateExtensionFromAsn1 = function(ext) {
    var e = {};
    e.id = asn12.derToOid(ext.value[0].value);
    e.critical = false;
    if (ext.value[1].type === asn12.Type.BOOLEAN) {
      e.critical = ext.value[1].value.charCodeAt(0) !== 0;
      e.value = ext.value[2].value;
    } else {
      e.value = ext.value[1].value;
    }
    if (e.id in oids2) {
      e.name = oids2[e.id];
      if (e.name === "keyUsage") {
        var ev = asn12.fromDer(e.value);
        var b2 = 0;
        var b3 = 0;
        if (ev.value.length > 1) {
          b2 = ev.value.charCodeAt(1);
          b3 = ev.value.length > 2 ? ev.value.charCodeAt(2) : 0;
        }
        e.digitalSignature = (b2 & 128) === 128;
        e.nonRepudiation = (b2 & 64) === 64;
        e.keyEncipherment = (b2 & 32) === 32;
        e.dataEncipherment = (b2 & 16) === 16;
        e.keyAgreement = (b2 & 8) === 8;
        e.keyCertSign = (b2 & 4) === 4;
        e.cRLSign = (b2 & 2) === 2;
        e.encipherOnly = (b2 & 1) === 1;
        e.decipherOnly = (b3 & 128) === 128;
      } else if (e.name === "basicConstraints") {
        var ev = asn12.fromDer(e.value);
        if (ev.value.length > 0 && ev.value[0].type === asn12.Type.BOOLEAN) {
          e.cA = ev.value[0].value.charCodeAt(0) !== 0;
        } else {
          e.cA = false;
        }
        var value = null;
        if (ev.value.length > 0 && ev.value[0].type === asn12.Type.INTEGER) {
          value = ev.value[0].value;
        } else if (ev.value.length > 1) {
          value = ev.value[1].value;
        }
        if (value !== null) {
          e.pathLenConstraint = asn12.derToInteger(value);
        }
      } else if (e.name === "extKeyUsage") {
        var ev = asn12.fromDer(e.value);
        for (var vi = 0; vi < ev.value.length; ++vi) {
          var oid = asn12.derToOid(ev.value[vi].value);
          if (oid in oids2) {
            e[oids2[oid]] = true;
          } else {
            e[oid] = true;
          }
        }
      } else if (e.name === "nsCertType") {
        var ev = asn12.fromDer(e.value);
        var b2 = 0;
        if (ev.value.length > 1) {
          b2 = ev.value.charCodeAt(1);
        }
        e.client = (b2 & 128) === 128;
        e.server = (b2 & 64) === 64;
        e.email = (b2 & 32) === 32;
        e.objsign = (b2 & 16) === 16;
        e.reserved = (b2 & 8) === 8;
        e.sslCA = (b2 & 4) === 4;
        e.emailCA = (b2 & 2) === 2;
        e.objCA = (b2 & 1) === 1;
      } else if (e.name === "subjectAltName" || e.name === "issuerAltName") {
        e.altNames = [];
        var gn;
        var ev = asn12.fromDer(e.value);
        for (var n = 0; n < ev.value.length; ++n) {
          gn = ev.value[n];
          var altName = {
            type: gn.type,
            value: gn.value
          };
          e.altNames.push(altName);
          switch (gn.type) {
            // rfc822Name
            case 1:
            // dNSName
            case 2:
            // uniformResourceIdentifier (URI)
            case 6:
              break;
            // IPAddress
            case 7:
              altName.ip = forge2.util.bytesToIP(gn.value);
              break;
            // registeredID
            case 8:
              altName.oid = asn12.derToOid(gn.value);
              break;
          }
        }
      } else if (e.name === "subjectKeyIdentifier") {
        var ev = asn12.fromDer(e.value);
        e.subjectKeyIdentifier = forge2.util.bytesToHex(ev.value);
      }
    }
    return e;
  };
  pki2.certificationRequestFromAsn1 = function(obj, computeHash) {
    var capture = {};
    var errors = [];
    if (!asn12.validate(obj, certificationRequestValidator, capture, errors)) {
      var error = new Error("Cannot read PKCS#10 certificate request. ASN.1 object is not a PKCS#10 CertificationRequest.");
      error.errors = errors;
      throw error;
    }
    var oid = asn12.derToOid(capture.publicKeyOid);
    if (oid !== pki2.oids.rsaEncryption) {
      throw new Error("Cannot read public key. OID is not RSA.");
    }
    var csr = pki2.createCertificationRequest();
    csr.version = capture.csrVersion ? capture.csrVersion.charCodeAt(0) : 0;
    csr.signatureOid = forge2.asn1.derToOid(capture.csrSignatureOid);
    csr.signatureParameters = _readSignatureParameters(
      csr.signatureOid,
      capture.csrSignatureParams,
      true
    );
    csr.siginfo.algorithmOid = forge2.asn1.derToOid(capture.csrSignatureOid);
    csr.siginfo.parameters = _readSignatureParameters(
      csr.siginfo.algorithmOid,
      capture.csrSignatureParams,
      false
    );
    csr.signature = capture.csrSignature;
    csr.certificationRequestInfo = capture.certificationRequestInfo;
    if (computeHash) {
      csr.md = _createSignatureDigest({
        signatureOid: csr.signatureOid,
        type: "certification request"
      });
      var bytes = asn12.toDer(csr.certificationRequestInfo);
      csr.md.update(bytes.getBytes());
    }
    var smd = forge2.md.sha1.create();
    csr.subject.getField = function(sn) {
      return _getAttribute(csr.subject, sn);
    };
    csr.subject.addField = function(attr) {
      _fillMissingFields([attr]);
      csr.subject.attributes.push(attr);
    };
    csr.subject.attributes = pki2.RDNAttributesAsArray(
      capture.certificationRequestInfoSubject,
      smd
    );
    csr.subject.hash = smd.digest().toHex();
    csr.publicKey = pki2.publicKeyFromAsn1(capture.subjectPublicKeyInfo);
    csr.getAttribute = function(sn) {
      return _getAttribute(csr, sn);
    };
    csr.addAttribute = function(attr) {
      _fillMissingFields([attr]);
      csr.attributes.push(attr);
    };
    csr.attributes = pki2.CRIAttributesAsArray(
      capture.certificationRequestInfoAttributes || []
    );
    return csr;
  };
  pki2.createCertificationRequest = function() {
    var csr = {};
    csr.version = 0;
    csr.signatureOid = null;
    csr.signature = null;
    csr.siginfo = {};
    csr.siginfo.algorithmOid = null;
    csr.subject = {};
    csr.subject.getField = function(sn) {
      return _getAttribute(csr.subject, sn);
    };
    csr.subject.addField = function(attr) {
      _fillMissingFields([attr]);
      csr.subject.attributes.push(attr);
    };
    csr.subject.attributes = [];
    csr.subject.hash = null;
    csr.publicKey = null;
    csr.attributes = [];
    csr.getAttribute = function(sn) {
      return _getAttribute(csr, sn);
    };
    csr.addAttribute = function(attr) {
      _fillMissingFields([attr]);
      csr.attributes.push(attr);
    };
    csr.md = null;
    csr.setSubject = function(attrs) {
      _fillMissingFields(attrs);
      csr.subject.attributes = attrs;
      csr.subject.hash = null;
    };
    csr.setAttributes = function(attrs) {
      _fillMissingFields(attrs);
      csr.attributes = attrs;
    };
    csr.sign = function(key, md2) {
      csr.md = md2 || forge2.md.sha1.create();
      var algorithmOid = oids2[csr.md.algorithm + "WithRSAEncryption"];
      if (!algorithmOid) {
        var error = new Error("Could not compute certification request digest. Unknown message digest algorithm OID.");
        error.algorithm = csr.md.algorithm;
        throw error;
      }
      csr.signatureOid = csr.siginfo.algorithmOid = algorithmOid;
      csr.certificationRequestInfo = pki2.getCertificationRequestInfo(csr);
      var bytes = asn12.toDer(csr.certificationRequestInfo);
      csr.md.update(bytes.getBytes());
      csr.signature = key.sign(csr.md);
    };
    csr.verify = function() {
      var rval = false;
      var md2 = csr.md;
      if (md2 === null) {
        md2 = _createSignatureDigest({
          signatureOid: csr.signatureOid,
          type: "certification request"
        });
        var cri = csr.certificationRequestInfo || pki2.getCertificationRequestInfo(csr);
        var bytes = asn12.toDer(cri);
        md2.update(bytes.getBytes());
      }
      if (md2 !== null) {
        rval = _verifySignature({
          certificate: csr,
          md: md2,
          signature: csr.signature
        });
      }
      return rval;
    };
    return csr;
  };
  function _dnToAsn1(obj) {
    var rval = asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.SEQUENCE,
      true,
      []
    );
    var attr, set;
    var attrs = obj.attributes;
    for (var i = 0; i < attrs.length; ++i) {
      attr = attrs[i];
      var value = attr.value;
      var valueTagClass = asn12.Type.PRINTABLESTRING;
      if ("valueTagClass" in attr) {
        valueTagClass = attr.valueTagClass;
        if (valueTagClass === asn12.Type.UTF8) {
          value = forge2.util.encodeUtf8(value);
        }
      }
      set = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SET, true, [
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // AttributeType
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(attr.type).getBytes()
          ),
          // AttributeValue
          asn12.create(asn12.Class.UNIVERSAL, valueTagClass, false, value)
        ])
      ]);
      rval.value.push(set);
    }
    return rval;
  }
  function _fillMissingFields(attrs) {
    var attr;
    for (var i = 0; i < attrs.length; ++i) {
      attr = attrs[i];
      if (typeof attr.name === "undefined") {
        if (attr.type && attr.type in pki2.oids) {
          attr.name = pki2.oids[attr.type];
        } else if (attr.shortName && attr.shortName in _shortNames) {
          attr.name = pki2.oids[_shortNames[attr.shortName]];
        }
      }
      if (typeof attr.type === "undefined") {
        if (attr.name && attr.name in pki2.oids) {
          attr.type = pki2.oids[attr.name];
        } else {
          var error = new Error("Attribute type not specified.");
          error.attribute = attr;
          throw error;
        }
      }
      if (typeof attr.shortName === "undefined") {
        if (attr.name && attr.name in _shortNames) {
          attr.shortName = _shortNames[attr.name];
        }
      }
      if (attr.type === oids2.extensionRequest) {
        attr.valueConstructed = true;
        attr.valueTagClass = asn12.Type.SEQUENCE;
        if (!attr.value && attr.extensions) {
          attr.value = [];
          for (var ei = 0; ei < attr.extensions.length; ++ei) {
            attr.value.push(pki2.certificateExtensionToAsn1(
              _fillMissingExtensionFields(attr.extensions[ei])
            ));
          }
        }
      }
      if (typeof attr.value === "undefined") {
        var error = new Error("Attribute value not specified.");
        error.attribute = attr;
        throw error;
      }
    }
  }
  function _fillMissingExtensionFields(e, options) {
    options = options || {};
    if (typeof e.name === "undefined") {
      if (e.id && e.id in pki2.oids) {
        e.name = pki2.oids[e.id];
      }
    }
    if (typeof e.id === "undefined") {
      if (e.name && e.name in pki2.oids) {
        e.id = pki2.oids[e.name];
      } else {
        var error = new Error("Extension ID not specified.");
        error.extension = e;
        throw error;
      }
    }
    if (typeof e.value !== "undefined") {
      return e;
    }
    if (e.name === "keyUsage") {
      var unused = 0;
      var b2 = 0;
      var b3 = 0;
      if (e.digitalSignature) {
        b2 |= 128;
        unused = 7;
      }
      if (e.nonRepudiation) {
        b2 |= 64;
        unused = 6;
      }
      if (e.keyEncipherment) {
        b2 |= 32;
        unused = 5;
      }
      if (e.dataEncipherment) {
        b2 |= 16;
        unused = 4;
      }
      if (e.keyAgreement) {
        b2 |= 8;
        unused = 3;
      }
      if (e.keyCertSign) {
        b2 |= 4;
        unused = 2;
      }
      if (e.cRLSign) {
        b2 |= 2;
        unused = 1;
      }
      if (e.encipherOnly) {
        b2 |= 1;
        unused = 0;
      }
      if (e.decipherOnly) {
        b3 |= 128;
        unused = 7;
      }
      var value = String.fromCharCode(unused);
      if (b3 !== 0) {
        value += String.fromCharCode(b2) + String.fromCharCode(b3);
      } else if (b2 !== 0) {
        value += String.fromCharCode(b2);
      }
      e.value = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.BITSTRING,
        false,
        value
      );
    } else if (e.name === "basicConstraints") {
      e.value = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.SEQUENCE,
        true,
        []
      );
      if (e.cA) {
        e.value.value.push(asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.BOOLEAN,
          false,
          String.fromCharCode(255)
        ));
      }
      if ("pathLenConstraint" in e) {
        e.value.value.push(asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.INTEGER,
          false,
          asn12.integerToDer(e.pathLenConstraint).getBytes()
        ));
      }
    } else if (e.name === "extKeyUsage") {
      e.value = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.SEQUENCE,
        true,
        []
      );
      var seq = e.value.value;
      for (var key in e) {
        if (e[key] !== true) {
          continue;
        }
        if (key in oids2) {
          seq.push(asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(oids2[key]).getBytes()
          ));
        } else if (key.indexOf(".") !== -1) {
          seq.push(asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(key).getBytes()
          ));
        }
      }
    } else if (e.name === "nsCertType") {
      var unused = 0;
      var b2 = 0;
      if (e.client) {
        b2 |= 128;
        unused = 7;
      }
      if (e.server) {
        b2 |= 64;
        unused = 6;
      }
      if (e.email) {
        b2 |= 32;
        unused = 5;
      }
      if (e.objsign) {
        b2 |= 16;
        unused = 4;
      }
      if (e.reserved) {
        b2 |= 8;
        unused = 3;
      }
      if (e.sslCA) {
        b2 |= 4;
        unused = 2;
      }
      if (e.emailCA) {
        b2 |= 2;
        unused = 1;
      }
      if (e.objCA) {
        b2 |= 1;
        unused = 0;
      }
      var value = String.fromCharCode(unused);
      if (b2 !== 0) {
        value += String.fromCharCode(b2);
      }
      e.value = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.BITSTRING,
        false,
        value
      );
    } else if (e.name === "subjectAltName" || e.name === "issuerAltName") {
      e.value = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, []);
      var altName;
      for (var n = 0; n < e.altNames.length; ++n) {
        altName = e.altNames[n];
        var value = altName.value;
        if (altName.type === 7 && altName.ip) {
          value = forge2.util.bytesFromIP(altName.ip);
          if (value === null) {
            var error = new Error(
              'Extension "ip" value is not a valid IPv4 or IPv6 address.'
            );
            error.extension = e;
            throw error;
          }
        } else if (altName.type === 8) {
          if (altName.oid) {
            value = asn12.oidToDer(asn12.oidToDer(altName.oid));
          } else {
            value = asn12.oidToDer(value);
          }
        }
        e.value.value.push(asn12.create(
          asn12.Class.CONTEXT_SPECIFIC,
          altName.type,
          false,
          value
        ));
      }
    } else if (e.name === "nsComment" && options.cert) {
      if (!/^[\x00-\x7F]*$/.test(e.comment) || e.comment.length < 1 || e.comment.length > 128) {
        throw new Error('Invalid "nsComment" content.');
      }
      e.value = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.IA5STRING,
        false,
        e.comment
      );
    } else if (e.name === "subjectKeyIdentifier" && options.cert) {
      var ski = options.cert.generateSubjectKeyIdentifier();
      e.subjectKeyIdentifier = ski.toHex();
      e.value = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OCTETSTRING,
        false,
        ski.getBytes()
      );
    } else if (e.name === "authorityKeyIdentifier" && options.cert) {
      e.value = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, []);
      var seq = e.value.value;
      if (e.keyIdentifier) {
        var keyIdentifier = e.keyIdentifier === true ? options.cert.generateSubjectKeyIdentifier().getBytes() : e.keyIdentifier;
        seq.push(
          asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, false, keyIdentifier)
        );
      }
      if (e.authorityCertIssuer) {
        var authorityCertIssuer = [
          asn12.create(asn12.Class.CONTEXT_SPECIFIC, 4, true, [
            _dnToAsn1(e.authorityCertIssuer === true ? options.cert.issuer : e.authorityCertIssuer)
          ])
        ];
        seq.push(
          asn12.create(asn12.Class.CONTEXT_SPECIFIC, 1, true, authorityCertIssuer)
        );
      }
      if (e.serialNumber) {
        var serialNumber = forge2.util.hexToBytes(e.serialNumber === true ? options.cert.serialNumber : e.serialNumber);
        seq.push(
          asn12.create(asn12.Class.CONTEXT_SPECIFIC, 2, false, serialNumber)
        );
      }
    } else if (e.name === "cRLDistributionPoints") {
      e.value = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, []);
      var seq = e.value.value;
      var subSeq = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.SEQUENCE,
        true,
        []
      );
      var fullNameGeneralNames = asn12.create(
        asn12.Class.CONTEXT_SPECIFIC,
        0,
        true,
        []
      );
      var altName;
      for (var n = 0; n < e.altNames.length; ++n) {
        altName = e.altNames[n];
        var value = altName.value;
        if (altName.type === 7 && altName.ip) {
          value = forge2.util.bytesFromIP(altName.ip);
          if (value === null) {
            var error = new Error(
              'Extension "ip" value is not a valid IPv4 or IPv6 address.'
            );
            error.extension = e;
            throw error;
          }
        } else if (altName.type === 8) {
          if (altName.oid) {
            value = asn12.oidToDer(asn12.oidToDer(altName.oid));
          } else {
            value = asn12.oidToDer(value);
          }
        }
        fullNameGeneralNames.value.push(asn12.create(
          asn12.Class.CONTEXT_SPECIFIC,
          altName.type,
          false,
          value
        ));
      }
      subSeq.value.push(asn12.create(
        asn12.Class.CONTEXT_SPECIFIC,
        0,
        true,
        [fullNameGeneralNames]
      ));
      seq.push(subSeq);
    }
    if (typeof e.value === "undefined") {
      var error = new Error("Extension value not specified.");
      error.extension = e;
      throw error;
    }
    return e;
  }
  function _signatureParametersToAsn1(oid, params) {
    switch (oid) {
      case oids2["RSASSA-PSS"]:
        var parts = [];
        if (params.hash.algorithmOid !== void 0) {
          parts.push(asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
            asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.OID,
                false,
                asn12.oidToDer(params.hash.algorithmOid).getBytes()
              ),
              asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
            ])
          ]));
        }
        if (params.mgf.algorithmOid !== void 0) {
          parts.push(asn12.create(asn12.Class.CONTEXT_SPECIFIC, 1, true, [
            asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.OID,
                false,
                asn12.oidToDer(params.mgf.algorithmOid).getBytes()
              ),
              asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
                asn12.create(
                  asn12.Class.UNIVERSAL,
                  asn12.Type.OID,
                  false,
                  asn12.oidToDer(params.mgf.hash.algorithmOid).getBytes()
                ),
                asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
              ])
            ])
          ]));
        }
        if (params.saltLength !== void 0) {
          parts.push(asn12.create(asn12.Class.CONTEXT_SPECIFIC, 2, true, [
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.INTEGER,
              false,
              asn12.integerToDer(params.saltLength).getBytes()
            )
          ]));
        }
        return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, parts);
      default:
        return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "");
    }
  }
  function _CRIAttributesToAsn1(csr) {
    var rval = asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, []);
    if (csr.attributes.length === 0) {
      return rval;
    }
    var attrs = csr.attributes;
    for (var i = 0; i < attrs.length; ++i) {
      var attr = attrs[i];
      var value = attr.value;
      var valueTagClass = asn12.Type.UTF8;
      if ("valueTagClass" in attr) {
        valueTagClass = attr.valueTagClass;
      }
      if (valueTagClass === asn12.Type.UTF8) {
        value = forge2.util.encodeUtf8(value);
      }
      var valueConstructed = false;
      if ("valueConstructed" in attr) {
        valueConstructed = attr.valueConstructed;
      }
      var seq = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // AttributeType
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(attr.type).getBytes()
        ),
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SET, true, [
          // AttributeValue
          asn12.create(
            asn12.Class.UNIVERSAL,
            valueTagClass,
            valueConstructed,
            value
          )
        ])
      ]);
      rval.value.push(seq);
    }
    return rval;
  }
  var jan_1_1950 = /* @__PURE__ */ new Date("1950-01-01T00:00:00Z");
  var jan_1_2050 = /* @__PURE__ */ new Date("2050-01-01T00:00:00Z");
  function _dateToAsn1(date) {
    if (date >= jan_1_1950 && date < jan_1_2050) {
      return asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.UTCTIME,
        false,
        asn12.dateToUtcTime(date)
      );
    } else {
      return asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.GENERALIZEDTIME,
        false,
        asn12.dateToGeneralizedTime(date)
      );
    }
  }
  pki2.getTBSCertificate = function(cert) {
    var notBefore = _dateToAsn1(cert.validity.notBefore);
    var notAfter = _dateToAsn1(cert.validity.notAfter);
    var tbs = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // version
      asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
        // integer
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.INTEGER,
          false,
          asn12.integerToDer(cert.version).getBytes()
        )
      ]),
      // serialNumber
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        forge2.util.hexToBytes(cert.serialNumber)
      ),
      // signature
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // algorithm
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(cert.siginfo.algorithmOid).getBytes()
        ),
        // parameters
        _signatureParametersToAsn1(
          cert.siginfo.algorithmOid,
          cert.siginfo.parameters
        )
      ]),
      // issuer
      _dnToAsn1(cert.issuer),
      // validity
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        notBefore,
        notAfter
      ]),
      // subject
      _dnToAsn1(cert.subject),
      // SubjectPublicKeyInfo
      pki2.publicKeyToAsn1(cert.publicKey)
    ]);
    if (cert.issuer.uniqueId) {
      tbs.value.push(
        asn12.create(asn12.Class.CONTEXT_SPECIFIC, 1, true, [
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.BITSTRING,
            false,
            // TODO: support arbitrary bit length ids
            String.fromCharCode(0) + cert.issuer.uniqueId
          )
        ])
      );
    }
    if (cert.subject.uniqueId) {
      tbs.value.push(
        asn12.create(asn12.Class.CONTEXT_SPECIFIC, 2, true, [
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.BITSTRING,
            false,
            // TODO: support arbitrary bit length ids
            String.fromCharCode(0) + cert.subject.uniqueId
          )
        ])
      );
    }
    if (cert.extensions.length > 0) {
      tbs.value.push(pki2.certificateExtensionsToAsn1(cert.extensions));
    }
    return tbs;
  };
  pki2.getCertificationRequestInfo = function(csr) {
    var cri = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // version
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        asn12.integerToDer(csr.version).getBytes()
      ),
      // subject
      _dnToAsn1(csr.subject),
      // SubjectPublicKeyInfo
      pki2.publicKeyToAsn1(csr.publicKey),
      // attributes
      _CRIAttributesToAsn1(csr)
    ]);
    return cri;
  };
  pki2.distinguishedNameToAsn1 = function(dn) {
    return _dnToAsn1(dn);
  };
  pki2.certificateToAsn1 = function(cert) {
    var tbsCertificate = cert.tbsCertificate || pki2.getTBSCertificate(cert);
    return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // TBSCertificate
      tbsCertificate,
      // AlgorithmIdentifier (signature algorithm)
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // algorithm
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(cert.signatureOid).getBytes()
        ),
        // parameters
        _signatureParametersToAsn1(cert.signatureOid, cert.signatureParameters)
      ]),
      // SignatureValue
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.BITSTRING,
        false,
        String.fromCharCode(0) + cert.signature
      )
    ]);
  };
  pki2.certificateExtensionsToAsn1 = function(exts) {
    var rval = asn12.create(asn12.Class.CONTEXT_SPECIFIC, 3, true, []);
    var seq = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, []);
    rval.value.push(seq);
    for (var i = 0; i < exts.length; ++i) {
      seq.value.push(pki2.certificateExtensionToAsn1(exts[i]));
    }
    return rval;
  };
  pki2.certificateExtensionToAsn1 = function(ext) {
    var extseq = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, []);
    extseq.value.push(asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.OID,
      false,
      asn12.oidToDer(ext.id).getBytes()
    ));
    if (ext.critical) {
      extseq.value.push(asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.BOOLEAN,
        false,
        String.fromCharCode(255)
      ));
    }
    var value = ext.value;
    if (typeof ext.value !== "string") {
      value = asn12.toDer(value).getBytes();
    }
    extseq.value.push(asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.OCTETSTRING,
      false,
      value
    ));
    return extseq;
  };
  pki2.certificationRequestToAsn1 = function(csr) {
    var cri = csr.certificationRequestInfo || pki2.getCertificationRequestInfo(csr);
    return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // CertificationRequestInfo
      cri,
      // AlgorithmIdentifier (signature algorithm)
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // algorithm
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(csr.signatureOid).getBytes()
        ),
        // parameters
        _signatureParametersToAsn1(csr.signatureOid, csr.signatureParameters)
      ]),
      // signature
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.BITSTRING,
        false,
        String.fromCharCode(0) + csr.signature
      )
    ]);
  };
  pki2.createCaStore = function(certs) {
    var caStore = {
      // stored certificates
      certs: {}
    };
    caStore.getIssuer = function(cert2) {
      var rval = getBySubject(cert2.issuer);
      return rval;
    };
    caStore.addCertificate = function(cert2) {
      if (typeof cert2 === "string") {
        cert2 = forge2.pki.certificateFromPem(cert2);
      }
      ensureSubjectHasHash(cert2.subject);
      if (!caStore.hasCertificate(cert2)) {
        if (cert2.subject.hash in caStore.certs) {
          var tmp = caStore.certs[cert2.subject.hash];
          if (!forge2.util.isArray(tmp)) {
            tmp = [tmp];
          }
          tmp.push(cert2);
          caStore.certs[cert2.subject.hash] = tmp;
        } else {
          caStore.certs[cert2.subject.hash] = cert2;
        }
      }
    };
    caStore.hasCertificate = function(cert2) {
      if (typeof cert2 === "string") {
        cert2 = forge2.pki.certificateFromPem(cert2);
      }
      var match = getBySubject(cert2.subject);
      if (!match) {
        return false;
      }
      if (!forge2.util.isArray(match)) {
        match = [match];
      }
      var der1 = asn12.toDer(pki2.certificateToAsn1(cert2)).getBytes();
      for (var i2 = 0; i2 < match.length; ++i2) {
        var der2 = asn12.toDer(pki2.certificateToAsn1(match[i2])).getBytes();
        if (der1 === der2) {
          return true;
        }
      }
      return false;
    };
    caStore.listAllCertificates = function() {
      var certList = [];
      for (var hash in caStore.certs) {
        if (caStore.certs.hasOwnProperty(hash)) {
          var value = caStore.certs[hash];
          if (!forge2.util.isArray(value)) {
            certList.push(value);
          } else {
            for (var i2 = 0; i2 < value.length; ++i2) {
              certList.push(value[i2]);
            }
          }
        }
      }
      return certList;
    };
    caStore.removeCertificate = function(cert2) {
      var result;
      if (typeof cert2 === "string") {
        cert2 = forge2.pki.certificateFromPem(cert2);
      }
      ensureSubjectHasHash(cert2.subject);
      if (!caStore.hasCertificate(cert2)) {
        return null;
      }
      var match = getBySubject(cert2.subject);
      if (!forge2.util.isArray(match)) {
        result = caStore.certs[cert2.subject.hash];
        delete caStore.certs[cert2.subject.hash];
        return result;
      }
      var der1 = asn12.toDer(pki2.certificateToAsn1(cert2)).getBytes();
      for (var i2 = 0; i2 < match.length; ++i2) {
        var der2 = asn12.toDer(pki2.certificateToAsn1(match[i2])).getBytes();
        if (der1 === der2) {
          result = match[i2];
          match.splice(i2, 1);
        }
      }
      if (match.length === 0) {
        delete caStore.certs[cert2.subject.hash];
      }
      return result;
    };
    function getBySubject(subject) {
      ensureSubjectHasHash(subject);
      return caStore.certs[subject.hash] || null;
    }
    function ensureSubjectHasHash(subject) {
      if (!subject.hash) {
        var md2 = forge2.md.sha1.create();
        subject.attributes = pki2.RDNAttributesAsArray(_dnToAsn1(subject), md2);
        subject.hash = md2.digest().toHex();
      }
    }
    if (certs) {
      for (var i = 0; i < certs.length; ++i) {
        var cert = certs[i];
        caStore.addCertificate(cert);
      }
    }
    return caStore;
  };
  pki2.certificateError = {
    bad_certificate: "forge.pki.BadCertificate",
    unsupported_certificate: "forge.pki.UnsupportedCertificate",
    certificate_revoked: "forge.pki.CertificateRevoked",
    certificate_expired: "forge.pki.CertificateExpired",
    certificate_unknown: "forge.pki.CertificateUnknown",
    unknown_ca: "forge.pki.UnknownCertificateAuthority"
  };
  pki2.verifyCertificateChain = function(caStore, chain, options) {
    if (typeof options === "function") {
      options = { verify: options };
    }
    options = options || {};
    chain = chain.slice(0);
    var certs = chain.slice(0);
    var validityCheckDate = options.validityCheckDate;
    if (typeof validityCheckDate === "undefined") {
      validityCheckDate = /* @__PURE__ */ new Date();
    }
    var first = true;
    var error = null;
    var depth = 0;
    do {
      var cert = chain.shift();
      var parent = null;
      var selfSigned = false;
      if (validityCheckDate) {
        if (validityCheckDate < cert.validity.notBefore || validityCheckDate > cert.validity.notAfter) {
          error = {
            message: "Certificate is not valid yet or has expired.",
            error: pki2.certificateError.certificate_expired,
            notBefore: cert.validity.notBefore,
            notAfter: cert.validity.notAfter,
            // TODO: we might want to reconsider renaming 'now' to
            // 'validityCheckDate' should this API be changed in the future.
            now: validityCheckDate
          };
        }
      }
      if (error === null) {
        parent = chain[0] || caStore.getIssuer(cert);
        if (parent === null) {
          if (cert.isIssuer(cert)) {
            selfSigned = true;
            parent = cert;
          }
        }
        if (parent) {
          var parents = parent;
          if (!forge2.util.isArray(parents)) {
            parents = [parents];
          }
          var verified = false;
          while (!verified && parents.length > 0) {
            parent = parents.shift();
            try {
              verified = parent.verify(cert);
            } catch (ex) {
            }
          }
          if (!verified) {
            error = {
              message: "Certificate signature is invalid.",
              error: pki2.certificateError.bad_certificate
            };
          }
        }
        if (error === null && (!parent || selfSigned) && !caStore.hasCertificate(cert)) {
          error = {
            message: "Certificate is not trusted.",
            error: pki2.certificateError.unknown_ca
          };
        }
      }
      if (error === null && parent && !cert.isIssuer(parent)) {
        error = {
          message: "Certificate issuer is invalid.",
          error: pki2.certificateError.bad_certificate
        };
      }
      if (error === null) {
        var se = {
          keyUsage: true,
          basicConstraints: true
        };
        for (var i = 0; error === null && i < cert.extensions.length; ++i) {
          var ext = cert.extensions[i];
          if (ext.critical && !(ext.name in se)) {
            error = {
              message: "Certificate has an unsupported critical extension.",
              error: pki2.certificateError.unsupported_certificate
            };
          }
        }
      }
      if (error === null && (!first || chain.length === 0 && (!parent || selfSigned))) {
        var bcExt = cert.getExtension("basicConstraints");
        var keyUsageExt = cert.getExtension("keyUsage");
        if (keyUsageExt !== null) {
          if (!keyUsageExt.keyCertSign || bcExt === null) {
            error = {
              message: "Certificate keyUsage or basicConstraints conflict or indicate that the certificate is not a CA. If the certificate is the only one in the chain or isn't the first then the certificate must be a valid CA.",
              error: pki2.certificateError.bad_certificate
            };
          }
        }
        if (error === null && bcExt === null) {
          error = {
            message: "Certificate is missing basicConstraints extension and cannot be used as a CA.",
            error: pki2.certificateError.bad_certificate
          };
        }
        if (error === null && bcExt !== null && !bcExt.cA) {
          error = {
            message: "Certificate basicConstraints indicates the certificate is not a CA.",
            error: pki2.certificateError.bad_certificate
          };
        }
        if (error === null && keyUsageExt !== null && "pathLenConstraint" in bcExt) {
          var pathLen = depth - 1;
          if (pathLen > bcExt.pathLenConstraint) {
            error = {
              message: "Certificate basicConstraints pathLenConstraint violated.",
              error: pki2.certificateError.bad_certificate
            };
          }
        }
      }
      var vfd = error === null ? true : error.error;
      var ret = options.verify ? options.verify(vfd, depth, certs) : vfd;
      if (ret === true) {
        error = null;
      } else {
        if (vfd === true) {
          error = {
            message: "The application rejected the certificate.",
            error: pki2.certificateError.bad_certificate
          };
        }
        if (ret || ret === 0) {
          if (typeof ret === "object" && !forge2.util.isArray(ret)) {
            if (ret.message) {
              error.message = ret.message;
            }
            if (ret.error) {
              error.error = ret.error;
            }
          } else if (typeof ret === "string") {
            error.error = ret;
          }
        }
        throw error;
      }
      first = false;
      ++depth;
    } while (chain.length > 0);
    return true;
  };
  return x509.exports;
}
var hasRequiredPkcs12;
function requirePkcs12() {
  if (hasRequiredPkcs12) return pkcs12.exports;
  hasRequiredPkcs12 = 1;
  var forge2 = requireForge();
  requireAsn1();
  requireHmac();
  requireOids();
  requirePkcs7asn1();
  requirePbe();
  requireRandom();
  requireRsa();
  requireSha1();
  requireUtil();
  requireX509();
  var asn12 = forge2.asn1;
  var pki2 = forge2.pki;
  var p12 = pkcs12.exports = forge2.pkcs12 = forge2.pkcs12 || {};
  var contentInfoValidator = {
    name: "ContentInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    // a ContentInfo
    constructed: true,
    value: [{
      name: "ContentInfo.contentType",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OID,
      constructed: false,
      capture: "contentType"
    }, {
      name: "ContentInfo.content",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      constructed: true,
      captureAsn1: "content"
    }]
  };
  var pfxValidator = {
    name: "PFX",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [
      {
        name: "PFX.version",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.INTEGER,
        constructed: false,
        capture: "version"
      },
      contentInfoValidator,
      {
        name: "PFX.macData",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SEQUENCE,
        constructed: true,
        optional: true,
        captureAsn1: "mac",
        value: [{
          name: "PFX.macData.mac",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.SEQUENCE,
          // DigestInfo
          constructed: true,
          value: [{
            name: "PFX.macData.mac.digestAlgorithm",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.SEQUENCE,
            // DigestAlgorithmIdentifier
            constructed: true,
            value: [{
              name: "PFX.macData.mac.digestAlgorithm.algorithm",
              tagClass: asn12.Class.UNIVERSAL,
              type: asn12.Type.OID,
              constructed: false,
              capture: "macAlgorithm"
            }, {
              name: "PFX.macData.mac.digestAlgorithm.parameters",
              optional: true,
              tagClass: asn12.Class.UNIVERSAL,
              captureAsn1: "macAlgorithmParameters"
            }]
          }, {
            name: "PFX.macData.mac.digest",
            tagClass: asn12.Class.UNIVERSAL,
            type: asn12.Type.OCTETSTRING,
            constructed: false,
            capture: "macDigest"
          }]
        }, {
          name: "PFX.macData.macSalt",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.OCTETSTRING,
          constructed: false,
          capture: "macSalt"
        }, {
          name: "PFX.macData.iterations",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.INTEGER,
          constructed: false,
          optional: true,
          capture: "macIterations"
        }]
      }
    ]
  };
  var safeBagValidator = {
    name: "SafeBag",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "SafeBag.bagId",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OID,
      constructed: false,
      capture: "bagId"
    }, {
      name: "SafeBag.bagValue",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      constructed: true,
      captureAsn1: "bagValue"
    }, {
      name: "SafeBag.bagAttributes",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SET,
      constructed: true,
      optional: true,
      capture: "bagAttributes"
    }]
  };
  var attributeValidator = {
    name: "Attribute",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "Attribute.attrId",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OID,
      constructed: false,
      capture: "oid"
    }, {
      name: "Attribute.attrValues",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SET,
      constructed: true,
      capture: "values"
    }]
  };
  var certBagValidator = {
    name: "CertBag",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      name: "CertBag.certId",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OID,
      constructed: false,
      capture: "certId"
    }, {
      name: "CertBag.certValue",
      tagClass: asn12.Class.CONTEXT_SPECIFIC,
      constructed: true,
      /* So far we only support X.509 certificates (which are wrapped in
         an OCTET STRING, hence hard code that here). */
      value: [{
        name: "CertBag.certValue[0]",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Class.OCTETSTRING,
        constructed: false,
        capture: "cert"
      }]
    }]
  };
  function _getBagsByAttribute(safeContents, attrName, attrValue, bagType) {
    var result = [];
    for (var i = 0; i < safeContents.length; i++) {
      for (var j = 0; j < safeContents[i].safeBags.length; j++) {
        var bag = safeContents[i].safeBags[j];
        if (bagType !== void 0 && bag.type !== bagType) {
          continue;
        }
        if (attrName === null) {
          result.push(bag);
          continue;
        }
        if (bag.attributes[attrName] !== void 0 && bag.attributes[attrName].indexOf(attrValue) >= 0) {
          result.push(bag);
        }
      }
    }
    return result;
  }
  p12.pkcs12FromAsn1 = function(obj, strict, password) {
    if (typeof strict === "string") {
      password = strict;
      strict = true;
    } else if (strict === void 0) {
      strict = true;
    }
    var capture = {};
    var errors = [];
    if (!asn12.validate(obj, pfxValidator, capture, errors)) {
      var error = new Error("Cannot read PKCS#12 PFX. ASN.1 object is not an PKCS#12 PFX.");
      error.errors = error;
      throw error;
    }
    var pfx = {
      version: capture.version.charCodeAt(0),
      safeContents: [],
      /**
       * Gets bags with matching attributes.
       *
       * @param filter the attributes to filter by:
       *          [localKeyId] the localKeyId to search for.
       *          [localKeyIdHex] the localKeyId in hex to search for.
       *          [friendlyName] the friendly name to search for.
       *          [bagType] bag type to narrow each attribute search by.
       *
       * @return a map of attribute type to an array of matching bags or, if no
       *           attribute was given but a bag type, the map key will be the
       *           bag type.
       */
      getBags: function(filter) {
        var rval = {};
        var localKeyId;
        if ("localKeyId" in filter) {
          localKeyId = filter.localKeyId;
        } else if ("localKeyIdHex" in filter) {
          localKeyId = forge2.util.hexToBytes(filter.localKeyIdHex);
        }
        if (localKeyId === void 0 && !("friendlyName" in filter) && "bagType" in filter) {
          rval[filter.bagType] = _getBagsByAttribute(
            pfx.safeContents,
            null,
            null,
            filter.bagType
          );
        }
        if (localKeyId !== void 0) {
          rval.localKeyId = _getBagsByAttribute(
            pfx.safeContents,
            "localKeyId",
            localKeyId,
            filter.bagType
          );
        }
        if ("friendlyName" in filter) {
          rval.friendlyName = _getBagsByAttribute(
            pfx.safeContents,
            "friendlyName",
            filter.friendlyName,
            filter.bagType
          );
        }
        return rval;
      },
      /**
       * DEPRECATED: use getBags() instead.
       *
       * Get bags with matching friendlyName attribute.
       *
       * @param friendlyName the friendly name to search for.
       * @param [bagType] bag type to narrow search by.
       *
       * @return an array of bags with matching friendlyName attribute.
       */
      getBagsByFriendlyName: function(friendlyName, bagType) {
        return _getBagsByAttribute(
          pfx.safeContents,
          "friendlyName",
          friendlyName,
          bagType
        );
      },
      /**
       * DEPRECATED: use getBags() instead.
       *
       * Get bags with matching localKeyId attribute.
       *
       * @param localKeyId the localKeyId to search for.
       * @param [bagType] bag type to narrow search by.
       *
       * @return an array of bags with matching localKeyId attribute.
       */
      getBagsByLocalKeyId: function(localKeyId, bagType) {
        return _getBagsByAttribute(
          pfx.safeContents,
          "localKeyId",
          localKeyId,
          bagType
        );
      }
    };
    if (capture.version.charCodeAt(0) !== 3) {
      var error = new Error("PKCS#12 PFX of version other than 3 not supported.");
      error.version = capture.version.charCodeAt(0);
      throw error;
    }
    if (asn12.derToOid(capture.contentType) !== pki2.oids.data) {
      var error = new Error("Only PKCS#12 PFX in password integrity mode supported.");
      error.oid = asn12.derToOid(capture.contentType);
      throw error;
    }
    var data = capture.content.value[0];
    if (data.tagClass !== asn12.Class.UNIVERSAL || data.type !== asn12.Type.OCTETSTRING) {
      throw new Error("PKCS#12 authSafe content data is not an OCTET STRING.");
    }
    data = _decodePkcs7Data(data);
    if (capture.mac) {
      var md2 = null;
      var macKeyBytes = 0;
      var macAlgorithm = asn12.derToOid(capture.macAlgorithm);
      switch (macAlgorithm) {
        case pki2.oids.sha1:
          md2 = forge2.md.sha1.create();
          macKeyBytes = 20;
          break;
        case pki2.oids.sha256:
          md2 = forge2.md.sha256.create();
          macKeyBytes = 32;
          break;
        case pki2.oids.sha384:
          md2 = forge2.md.sha384.create();
          macKeyBytes = 48;
          break;
        case pki2.oids.sha512:
          md2 = forge2.md.sha512.create();
          macKeyBytes = 64;
          break;
        case pki2.oids.md5:
          md2 = forge2.md.md5.create();
          macKeyBytes = 16;
          break;
      }
      if (md2 === null) {
        throw new Error("PKCS#12 uses unsupported MAC algorithm: " + macAlgorithm);
      }
      var macSalt = new forge2.util.ByteBuffer(capture.macSalt);
      var macIterations = "macIterations" in capture ? parseInt(forge2.util.bytesToHex(capture.macIterations), 16) : 1;
      var macKey = p12.generateKey(
        password,
        macSalt,
        3,
        macIterations,
        macKeyBytes,
        md2
      );
      var mac = forge2.hmac.create();
      mac.start(md2, macKey);
      mac.update(data.value);
      var macValue = mac.getMac();
      if (macValue.getBytes() !== capture.macDigest) {
        throw new Error("PKCS#12 MAC could not be verified. Invalid password?");
      }
    } else if (Array.isArray(obj.value) && obj.value.length > 2) {
      throw new Error("Invalid PKCS#12. macData field present but MAC was not validated.");
    }
    _decodeAuthenticatedSafe(pfx, data.value, strict, password);
    return pfx;
  };
  function _decodePkcs7Data(data) {
    if (data.composed || data.constructed) {
      var value = forge2.util.createBuffer();
      for (var i = 0; i < data.value.length; ++i) {
        value.putBytes(data.value[i].value);
      }
      data.composed = data.constructed = false;
      data.value = value.getBytes();
    }
    return data;
  }
  function _decodeAuthenticatedSafe(pfx, authSafe, strict, password) {
    authSafe = asn12.fromDer(authSafe, strict);
    if (authSafe.tagClass !== asn12.Class.UNIVERSAL || authSafe.type !== asn12.Type.SEQUENCE || authSafe.constructed !== true) {
      throw new Error("PKCS#12 AuthenticatedSafe expected to be a SEQUENCE OF ContentInfo");
    }
    for (var i = 0; i < authSafe.value.length; i++) {
      var contentInfo = authSafe.value[i];
      var capture = {};
      var errors = [];
      if (!asn12.validate(contentInfo, contentInfoValidator, capture, errors)) {
        var error = new Error("Cannot read ContentInfo.");
        error.errors = errors;
        throw error;
      }
      var obj = {
        encrypted: false
      };
      var safeContents = null;
      var data = capture.content.value[0];
      switch (asn12.derToOid(capture.contentType)) {
        case pki2.oids.data:
          if (data.tagClass !== asn12.Class.UNIVERSAL || data.type !== asn12.Type.OCTETSTRING) {
            throw new Error("PKCS#12 SafeContents Data is not an OCTET STRING.");
          }
          safeContents = _decodePkcs7Data(data).value;
          break;
        case pki2.oids.encryptedData:
          safeContents = _decryptSafeContents(data, password);
          obj.encrypted = true;
          break;
        default:
          var error = new Error("Unsupported PKCS#12 contentType.");
          error.contentType = asn12.derToOid(capture.contentType);
          throw error;
      }
      obj.safeBags = _decodeSafeContents(safeContents, strict, password);
      pfx.safeContents.push(obj);
    }
  }
  function _decryptSafeContents(data, password) {
    var capture = {};
    var errors = [];
    if (!asn12.validate(
      data,
      forge2.pkcs7.asn1.encryptedDataValidator,
      capture,
      errors
    )) {
      var error = new Error("Cannot read EncryptedContentInfo.");
      error.errors = errors;
      throw error;
    }
    var oid = asn12.derToOid(capture.contentType);
    if (oid !== pki2.oids.data) {
      var error = new Error(
        "PKCS#12 EncryptedContentInfo ContentType is not Data."
      );
      error.oid = oid;
      throw error;
    }
    oid = asn12.derToOid(capture.encAlgorithm);
    var cipher2 = pki2.pbe.getCipher(oid, capture.encParameter, password);
    var encryptedContentAsn1 = _decodePkcs7Data(capture.encryptedContentAsn1);
    var encrypted = forge2.util.createBuffer(encryptedContentAsn1.value);
    cipher2.update(encrypted);
    if (!cipher2.finish()) {
      throw new Error("Failed to decrypt PKCS#12 SafeContents.");
    }
    return cipher2.output.getBytes();
  }
  function _decodeSafeContents(safeContents, strict, password) {
    if (!strict && safeContents.length === 0) {
      return [];
    }
    safeContents = asn12.fromDer(safeContents, strict);
    if (safeContents.tagClass !== asn12.Class.UNIVERSAL || safeContents.type !== asn12.Type.SEQUENCE || safeContents.constructed !== true) {
      throw new Error(
        "PKCS#12 SafeContents expected to be a SEQUENCE OF SafeBag."
      );
    }
    var res = [];
    for (var i = 0; i < safeContents.value.length; i++) {
      var safeBag = safeContents.value[i];
      var capture = {};
      var errors = [];
      if (!asn12.validate(safeBag, safeBagValidator, capture, errors)) {
        var error = new Error("Cannot read SafeBag.");
        error.errors = errors;
        throw error;
      }
      var bag = {
        type: asn12.derToOid(capture.bagId),
        attributes: _decodeBagAttributes(capture.bagAttributes)
      };
      res.push(bag);
      var validator, decoder;
      var bagAsn1 = capture.bagValue.value[0];
      switch (bag.type) {
        case pki2.oids.pkcs8ShroudedKeyBag:
          bagAsn1 = pki2.decryptPrivateKeyInfo(bagAsn1, password);
          if (bagAsn1 === null) {
            throw new Error(
              "Unable to decrypt PKCS#8 ShroudedKeyBag, wrong password?"
            );
          }
        /* fall through */
        case pki2.oids.keyBag:
          try {
            bag.key = pki2.privateKeyFromAsn1(bagAsn1);
          } catch (e) {
            bag.key = null;
            bag.asn1 = bagAsn1;
          }
          continue;
        /* Nothing more to do. */
        case pki2.oids.certBag:
          validator = certBagValidator;
          decoder = function() {
            if (asn12.derToOid(capture.certId) !== pki2.oids.x509Certificate) {
              var error2 = new Error(
                "Unsupported certificate type, only X.509 supported."
              );
              error2.oid = asn12.derToOid(capture.certId);
              throw error2;
            }
            var certAsn1 = asn12.fromDer(capture.cert, strict);
            try {
              bag.cert = pki2.certificateFromAsn1(certAsn1, true);
            } catch (e) {
              bag.cert = null;
              bag.asn1 = certAsn1;
            }
          };
          break;
        default:
          var error = new Error("Unsupported PKCS#12 SafeBag type.");
          error.oid = bag.type;
          throw error;
      }
      if (validator !== void 0 && !asn12.validate(bagAsn1, validator, capture, errors)) {
        var error = new Error("Cannot read PKCS#12 " + validator.name);
        error.errors = errors;
        throw error;
      }
      decoder();
    }
    return res;
  }
  function _decodeBagAttributes(attributes) {
    var decodedAttrs = {};
    if (attributes !== void 0) {
      for (var i = 0; i < attributes.length; ++i) {
        var capture = {};
        var errors = [];
        if (!asn12.validate(attributes[i], attributeValidator, capture, errors)) {
          var error = new Error("Cannot read PKCS#12 BagAttribute.");
          error.errors = errors;
          throw error;
        }
        var oid = asn12.derToOid(capture.oid);
        if (pki2.oids[oid] === void 0) {
          continue;
        }
        decodedAttrs[pki2.oids[oid]] = [];
        for (var j = 0; j < capture.values.length; ++j) {
          decodedAttrs[pki2.oids[oid]].push(capture.values[j].value);
        }
      }
    }
    return decodedAttrs;
  }
  p12.toPkcs12Asn1 = function(key, cert, password, options) {
    options = options || {};
    options.saltSize = options.saltSize || 8;
    options.count = options.count || 2048;
    options.algorithm = options.algorithm || options.encAlgorithm || "aes128";
    if (!("useMac" in options)) {
      options.useMac = true;
    }
    if (!("localKeyId" in options)) {
      options.localKeyId = null;
    }
    if (!("generateLocalKeyId" in options)) {
      options.generateLocalKeyId = true;
    }
    var localKeyId = options.localKeyId;
    var bagAttrs;
    if (localKeyId !== null) {
      localKeyId = forge2.util.hexToBytes(localKeyId);
    } else if (options.generateLocalKeyId) {
      if (cert) {
        var pairedCert = forge2.util.isArray(cert) ? cert[0] : cert;
        if (typeof pairedCert === "string") {
          pairedCert = pki2.certificateFromPem(pairedCert);
        }
        var sha12 = forge2.md.sha1.create();
        sha12.update(asn12.toDer(pki2.certificateToAsn1(pairedCert)).getBytes());
        localKeyId = sha12.digest().getBytes();
      } else {
        localKeyId = forge2.random.getBytes(20);
      }
    }
    var attrs = [];
    if (localKeyId !== null) {
      attrs.push(
        // localKeyID
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // attrId
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(pki2.oids.localKeyId).getBytes()
          ),
          // attrValues
          asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SET, true, [
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.OCTETSTRING,
              false,
              localKeyId
            )
          ])
        ])
      );
    }
    if ("friendlyName" in options) {
      attrs.push(
        // friendlyName
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // attrId
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(pki2.oids.friendlyName).getBytes()
          ),
          // attrValues
          asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SET, true, [
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.BMPSTRING,
              false,
              options.friendlyName
            )
          ])
        ])
      );
    }
    if (attrs.length > 0) {
      bagAttrs = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SET, true, attrs);
    }
    var contents = [];
    var chain = [];
    if (cert !== null) {
      if (forge2.util.isArray(cert)) {
        chain = cert;
      } else {
        chain = [cert];
      }
    }
    var certSafeBags = [];
    for (var i = 0; i < chain.length; ++i) {
      cert = chain[i];
      if (typeof cert === "string") {
        cert = pki2.certificateFromPem(cert);
      }
      var certBagAttrs = i === 0 ? bagAttrs : void 0;
      var certAsn1 = pki2.certificateToAsn1(cert);
      var certSafeBag = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // bagId
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(pki2.oids.certBag).getBytes()
        ),
        // bagValue
        asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
          // CertBag
          asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
            // certId
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.OID,
              false,
              asn12.oidToDer(pki2.oids.x509Certificate).getBytes()
            ),
            // certValue (x509Certificate)
            asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.OCTETSTRING,
                false,
                asn12.toDer(certAsn1).getBytes()
              )
            ])
          ])
        ]),
        // bagAttributes (OPTIONAL)
        certBagAttrs
      ]);
      certSafeBags.push(certSafeBag);
    }
    if (certSafeBags.length > 0) {
      var certSafeContents = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.SEQUENCE,
        true,
        certSafeBags
      );
      var certCI = (
        // PKCS#7 ContentInfo
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // contentType
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            // OID for the content type is 'data'
            asn12.oidToDer(pki2.oids.data).getBytes()
          ),
          // content
          asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.OCTETSTRING,
              false,
              asn12.toDer(certSafeContents).getBytes()
            )
          ])
        ])
      );
      contents.push(certCI);
    }
    var keyBag = null;
    if (key !== null) {
      var pkAsn1 = pki2.wrapRsaPrivateKey(pki2.privateKeyToAsn1(key));
      if (password === null) {
        keyBag = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // bagId
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(pki2.oids.keyBag).getBytes()
          ),
          // bagValue
          asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
            // PrivateKeyInfo
            pkAsn1
          ]),
          // bagAttributes (OPTIONAL)
          bagAttrs
        ]);
      } else {
        keyBag = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // bagId
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(pki2.oids.pkcs8ShroudedKeyBag).getBytes()
          ),
          // bagValue
          asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
            // EncryptedPrivateKeyInfo
            pki2.encryptPrivateKeyInfo(pkAsn1, password, options)
          ]),
          // bagAttributes (OPTIONAL)
          bagAttrs
        ]);
      }
      var keySafeContents = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [keyBag]);
      var keyCI = (
        // PKCS#7 ContentInfo
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // contentType
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            // OID for the content type is 'data'
            asn12.oidToDer(pki2.oids.data).getBytes()
          ),
          // content
          asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.OCTETSTRING,
              false,
              asn12.toDer(keySafeContents).getBytes()
            )
          ])
        ])
      );
      contents.push(keyCI);
    }
    var safe = asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.SEQUENCE,
      true,
      contents
    );
    var macData;
    if (options.useMac) {
      var sha12 = forge2.md.sha1.create();
      var macSalt = new forge2.util.ByteBuffer(
        forge2.random.getBytes(options.saltSize)
      );
      var count = options.count;
      var key = p12.generateKey(password, macSalt, 3, count, 20);
      var mac = forge2.hmac.create();
      mac.start(sha12, key);
      mac.update(asn12.toDer(safe).getBytes());
      var macValue = mac.getMac();
      macData = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // mac DigestInfo
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // digestAlgorithm
          asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
            // algorithm = SHA-1
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.OID,
              false,
              asn12.oidToDer(pki2.oids.sha1).getBytes()
            ),
            // parameters = Null
            asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
          ]),
          // digest
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OCTETSTRING,
            false,
            macValue.getBytes()
          )
        ]),
        // macSalt OCTET STRING
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OCTETSTRING,
          false,
          macSalt.getBytes()
        ),
        // iterations INTEGER (XXX: Only support count < 65536)
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.INTEGER,
          false,
          asn12.integerToDer(count).getBytes()
        )
      ]);
    }
    return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // version (3)
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        asn12.integerToDer(3).getBytes()
      ),
      // PKCS#7 ContentInfo
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // contentType
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          // OID for the content type is 'data'
          asn12.oidToDer(pki2.oids.data).getBytes()
        ),
        // content
        asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OCTETSTRING,
            false,
            asn12.toDer(safe).getBytes()
          )
        ])
      ]),
      macData
    ]);
  };
  p12.generateKey = forge2.pbe.generatePkcs12Key;
  return pkcs12.exports;
}
var hasRequiredPki;
function requirePki() {
  if (hasRequiredPki) return pki.exports;
  hasRequiredPki = 1;
  var forge2 = requireForge();
  requireAsn1();
  requireOids();
  requirePbe();
  requirePem();
  requirePbkdf2();
  requirePkcs12();
  requirePss();
  requireRsa();
  requireUtil();
  requireX509();
  var asn12 = forge2.asn1;
  var pki$1 = pki.exports = forge2.pki = forge2.pki || {};
  pki$1.pemToDer = function(pem2) {
    var msg = forge2.pem.decode(pem2)[0];
    if (msg.procType && msg.procType.type === "ENCRYPTED") {
      throw new Error("Could not convert PEM to DER; PEM is encrypted.");
    }
    return forge2.util.createBuffer(msg.body);
  };
  pki$1.privateKeyFromPem = function(pem2) {
    var msg = forge2.pem.decode(pem2)[0];
    if (msg.type !== "PRIVATE KEY" && msg.type !== "RSA PRIVATE KEY") {
      var error = new Error('Could not convert private key from PEM; PEM header type is not "PRIVATE KEY" or "RSA PRIVATE KEY".');
      error.headerType = msg.type;
      throw error;
    }
    if (msg.procType && msg.procType.type === "ENCRYPTED") {
      throw new Error("Could not convert private key from PEM; PEM is encrypted.");
    }
    var obj = asn12.fromDer(msg.body);
    return pki$1.privateKeyFromAsn1(obj);
  };
  pki$1.privateKeyToPem = function(key, maxline) {
    var msg = {
      type: "RSA PRIVATE KEY",
      body: asn12.toDer(pki$1.privateKeyToAsn1(key)).getBytes()
    };
    return forge2.pem.encode(msg, { maxline });
  };
  pki$1.privateKeyInfoToPem = function(pki2, maxline) {
    var msg = {
      type: "PRIVATE KEY",
      body: asn12.toDer(pki2).getBytes()
    };
    return forge2.pem.encode(msg, { maxline });
  };
  return pki.exports;
}
var tls_1;
var hasRequiredTls;
function requireTls() {
  if (hasRequiredTls) return tls_1;
  hasRequiredTls = 1;
  var forge2 = requireForge();
  requireAsn1();
  requireHmac();
  requireMd5();
  requirePem();
  requirePki();
  requireRandom();
  requireSha1();
  requireUtil();
  var prf_TLS1 = function(secret, label, seed, length) {
    var rval = forge2.util.createBuffer();
    var idx = secret.length >> 1;
    var slen = idx + (secret.length & 1);
    var s1 = secret.substr(0, slen);
    var s2 = secret.substr(idx, slen);
    var ai = forge2.util.createBuffer();
    var hmac2 = forge2.hmac.create();
    seed = label + seed;
    var md5itr = Math.ceil(length / 16);
    var sha1itr = Math.ceil(length / 20);
    hmac2.start("MD5", s1);
    var md5bytes = forge2.util.createBuffer();
    ai.putBytes(seed);
    for (var i = 0; i < md5itr; ++i) {
      hmac2.start(null, null);
      hmac2.update(ai.getBytes());
      ai.putBuffer(hmac2.digest());
      hmac2.start(null, null);
      hmac2.update(ai.bytes() + seed);
      md5bytes.putBuffer(hmac2.digest());
    }
    hmac2.start("SHA1", s2);
    var sha1bytes = forge2.util.createBuffer();
    ai.clear();
    ai.putBytes(seed);
    for (var i = 0; i < sha1itr; ++i) {
      hmac2.start(null, null);
      hmac2.update(ai.getBytes());
      ai.putBuffer(hmac2.digest());
      hmac2.start(null, null);
      hmac2.update(ai.bytes() + seed);
      sha1bytes.putBuffer(hmac2.digest());
    }
    rval.putBytes(forge2.util.xorBytes(
      md5bytes.getBytes(),
      sha1bytes.getBytes(),
      length
    ));
    return rval;
  };
  var hmac_sha1 = function(key2, seqNum, record) {
    var hmac2 = forge2.hmac.create();
    hmac2.start("SHA1", key2);
    var b = forge2.util.createBuffer();
    b.putInt32(seqNum[0]);
    b.putInt32(seqNum[1]);
    b.putByte(record.type);
    b.putByte(record.version.major);
    b.putByte(record.version.minor);
    b.putInt16(record.length);
    b.putBytes(record.fragment.bytes());
    hmac2.update(b.getBytes());
    return hmac2.digest().getBytes();
  };
  var deflate = function(c, record, s) {
    var rval = false;
    try {
      var bytes = c.deflate(record.fragment.getBytes());
      record.fragment = forge2.util.createBuffer(bytes);
      record.length = bytes.length;
      rval = true;
    } catch (ex) {
    }
    return rval;
  };
  var inflate = function(c, record, s) {
    var rval = false;
    try {
      var bytes = c.inflate(record.fragment.getBytes());
      record.fragment = forge2.util.createBuffer(bytes);
      record.length = bytes.length;
      rval = true;
    } catch (ex) {
    }
    return rval;
  };
  var readVector = function(b, lenBytes) {
    var len = 0;
    switch (lenBytes) {
      case 1:
        len = b.getByte();
        break;
      case 2:
        len = b.getInt16();
        break;
      case 3:
        len = b.getInt24();
        break;
      case 4:
        len = b.getInt32();
        break;
    }
    return forge2.util.createBuffer(b.getBytes(len));
  };
  var writeVector = function(b, lenBytes, v) {
    b.putInt(v.length(), lenBytes << 3);
    b.putBuffer(v);
  };
  var tls = {};
  tls.Versions = {
    TLS_1_0: { major: 3, minor: 1 },
    TLS_1_1: { major: 3, minor: 2 },
    TLS_1_2: { major: 3, minor: 3 }
  };
  tls.SupportedVersions = [
    tls.Versions.TLS_1_1,
    tls.Versions.TLS_1_0
  ];
  tls.Version = tls.SupportedVersions[0];
  tls.MaxFragment = 16384 - 1024;
  tls.ConnectionEnd = {
    server: 0,
    client: 1
  };
  tls.PRFAlgorithm = {
    tls_prf_sha256: 0
  };
  tls.BulkCipherAlgorithm = {
    none: null,
    rc4: 0,
    des3: 1,
    aes: 2
  };
  tls.CipherType = {
    stream: 0,
    block: 1,
    aead: 2
  };
  tls.MACAlgorithm = {
    none: null,
    hmac_md5: 0,
    hmac_sha1: 1,
    hmac_sha256: 2,
    hmac_sha384: 3,
    hmac_sha512: 4
  };
  tls.CompressionMethod = {
    none: 0,
    deflate: 1
  };
  tls.ContentType = {
    change_cipher_spec: 20,
    alert: 21,
    handshake: 22,
    application_data: 23,
    heartbeat: 24
  };
  tls.HandshakeType = {
    hello_request: 0,
    client_hello: 1,
    server_hello: 2,
    certificate: 11,
    server_key_exchange: 12,
    certificate_request: 13,
    server_hello_done: 14,
    certificate_verify: 15,
    client_key_exchange: 16,
    finished: 20
  };
  tls.Alert = {};
  tls.Alert.Level = {
    warning: 1,
    fatal: 2
  };
  tls.Alert.Description = {
    close_notify: 0,
    unexpected_message: 10,
    bad_record_mac: 20,
    decryption_failed: 21,
    record_overflow: 22,
    decompression_failure: 30,
    handshake_failure: 40,
    bad_certificate: 42,
    unsupported_certificate: 43,
    certificate_revoked: 44,
    certificate_expired: 45,
    certificate_unknown: 46,
    illegal_parameter: 47,
    unknown_ca: 48,
    access_denied: 49,
    decode_error: 50,
    decrypt_error: 51,
    export_restriction: 60,
    protocol_version: 70,
    insufficient_security: 71,
    internal_error: 80,
    user_canceled: 90,
    no_renegotiation: 100
  };
  tls.HeartbeatMessageType = {
    heartbeat_request: 1,
    heartbeat_response: 2
  };
  tls.CipherSuites = {};
  tls.getCipherSuite = function(twoBytes) {
    var rval = null;
    for (var key2 in tls.CipherSuites) {
      var cs = tls.CipherSuites[key2];
      if (cs.id[0] === twoBytes.charCodeAt(0) && cs.id[1] === twoBytes.charCodeAt(1)) {
        rval = cs;
        break;
      }
    }
    return rval;
  };
  tls.handleUnexpected = function(c, record) {
    var ignore2 = !c.open && c.entity === tls.ConnectionEnd.client;
    if (!ignore2) {
      c.error(c, {
        message: "Unexpected message. Received TLS record out of order.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.unexpected_message
        }
      });
    }
  };
  tls.handleHelloRequest = function(c, record, length) {
    if (!c.handshaking && c.handshakes > 0) {
      tls.queue(c, tls.createAlert(c, {
        level: tls.Alert.Level.warning,
        description: tls.Alert.Description.no_renegotiation
      }));
      tls.flush(c);
    }
    c.process();
  };
  tls.parseHelloMessage = function(c, record, length) {
    var msg = null;
    var client = c.entity === tls.ConnectionEnd.client;
    if (length < 38) {
      c.error(c, {
        message: client ? "Invalid ServerHello message. Message too short." : "Invalid ClientHello message. Message too short.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.illegal_parameter
        }
      });
    } else {
      var b = record.fragment;
      var remaining = b.length();
      msg = {
        version: {
          major: b.getByte(),
          minor: b.getByte()
        },
        random: forge2.util.createBuffer(b.getBytes(32)),
        session_id: readVector(b, 1),
        extensions: []
      };
      if (client) {
        msg.cipher_suite = b.getBytes(2);
        msg.compression_method = b.getByte();
      } else {
        msg.cipher_suites = readVector(b, 2);
        msg.compression_methods = readVector(b, 1);
      }
      remaining = length - (remaining - b.length());
      if (remaining > 0) {
        var exts = readVector(b, 2);
        while (exts.length() > 0) {
          msg.extensions.push({
            type: [exts.getByte(), exts.getByte()],
            data: readVector(exts, 2)
          });
        }
        if (!client) {
          for (var i = 0; i < msg.extensions.length; ++i) {
            var ext = msg.extensions[i];
            if (ext.type[0] === 0 && ext.type[1] === 0) {
              var snl = readVector(ext.data, 2);
              while (snl.length() > 0) {
                var snType = snl.getByte();
                if (snType !== 0) {
                  break;
                }
                c.session.extensions.server_name.serverNameList.push(
                  readVector(snl, 2).getBytes()
                );
              }
            }
          }
        }
      }
      if (c.session.version) {
        if (msg.version.major !== c.session.version.major || msg.version.minor !== c.session.version.minor) {
          return c.error(c, {
            message: "TLS version change is disallowed during renegotiation.",
            send: true,
            alert: {
              level: tls.Alert.Level.fatal,
              description: tls.Alert.Description.protocol_version
            }
          });
        }
      }
      if (client) {
        c.session.cipherSuite = tls.getCipherSuite(msg.cipher_suite);
      } else {
        var tmp = forge2.util.createBuffer(msg.cipher_suites.bytes());
        while (tmp.length() > 0) {
          c.session.cipherSuite = tls.getCipherSuite(tmp.getBytes(2));
          if (c.session.cipherSuite !== null) {
            break;
          }
        }
      }
      if (c.session.cipherSuite === null) {
        return c.error(c, {
          message: "No cipher suites in common.",
          send: true,
          alert: {
            level: tls.Alert.Level.fatal,
            description: tls.Alert.Description.handshake_failure
          },
          cipherSuite: forge2.util.bytesToHex(msg.cipher_suite)
        });
      }
      if (client) {
        c.session.compressionMethod = msg.compression_method;
      } else {
        c.session.compressionMethod = tls.CompressionMethod.none;
      }
    }
    return msg;
  };
  tls.createSecurityParameters = function(c, msg) {
    var client = c.entity === tls.ConnectionEnd.client;
    var msgRandom = msg.random.bytes();
    var cRandom = client ? c.session.sp.client_random : msgRandom;
    var sRandom = client ? msgRandom : tls.createRandom().getBytes();
    c.session.sp = {
      entity: c.entity,
      prf_algorithm: tls.PRFAlgorithm.tls_prf_sha256,
      bulk_cipher_algorithm: null,
      cipher_type: null,
      enc_key_length: null,
      block_length: null,
      fixed_iv_length: null,
      record_iv_length: null,
      mac_algorithm: null,
      mac_length: null,
      mac_key_length: null,
      compression_algorithm: c.session.compressionMethod,
      pre_master_secret: null,
      master_secret: null,
      client_random: cRandom,
      server_random: sRandom
    };
  };
  tls.handleServerHello = function(c, record, length) {
    var msg = tls.parseHelloMessage(c, record, length);
    if (c.fail) {
      return;
    }
    if (msg.version.minor <= c.version.minor) {
      c.version.minor = msg.version.minor;
    } else {
      return c.error(c, {
        message: "Incompatible TLS version.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.protocol_version
        }
      });
    }
    c.session.version = c.version;
    var sessionId = msg.session_id.bytes();
    if (sessionId.length > 0 && sessionId === c.session.id) {
      c.expect = SCC;
      c.session.resuming = true;
      c.session.sp.server_random = msg.random.bytes();
    } else {
      c.expect = SCE;
      c.session.resuming = false;
      tls.createSecurityParameters(c, msg);
    }
    c.session.id = sessionId;
    c.process();
  };
  tls.handleClientHello = function(c, record, length) {
    var msg = tls.parseHelloMessage(c, record, length);
    if (c.fail) {
      return;
    }
    var sessionId = msg.session_id.bytes();
    var session = null;
    if (c.sessionCache) {
      session = c.sessionCache.getSession(sessionId);
      if (session === null) {
        sessionId = "";
      } else if (session.version.major !== msg.version.major || session.version.minor > msg.version.minor) {
        session = null;
        sessionId = "";
      }
    }
    if (sessionId.length === 0) {
      sessionId = forge2.random.getBytes(32);
    }
    c.session.id = sessionId;
    c.session.clientHelloVersion = msg.version;
    c.session.sp = {};
    if (session) {
      c.version = c.session.version = session.version;
      c.session.sp = session.sp;
    } else {
      var version;
      for (var i = 1; i < tls.SupportedVersions.length; ++i) {
        version = tls.SupportedVersions[i];
        if (version.minor <= msg.version.minor) {
          break;
        }
      }
      c.version = { major: version.major, minor: version.minor };
      c.session.version = c.version;
    }
    if (session !== null) {
      c.expect = CCC;
      c.session.resuming = true;
      c.session.sp.client_random = msg.random.bytes();
    } else {
      c.expect = c.verifyClient !== false ? CCE : CKE;
      c.session.resuming = false;
      tls.createSecurityParameters(c, msg);
    }
    c.open = true;
    tls.queue(c, tls.createRecord(c, {
      type: tls.ContentType.handshake,
      data: tls.createServerHello(c)
    }));
    if (c.session.resuming) {
      tls.queue(c, tls.createRecord(c, {
        type: tls.ContentType.change_cipher_spec,
        data: tls.createChangeCipherSpec()
      }));
      c.state.pending = tls.createConnectionState(c);
      c.state.current.write = c.state.pending.write;
      tls.queue(c, tls.createRecord(c, {
        type: tls.ContentType.handshake,
        data: tls.createFinished(c)
      }));
    } else {
      tls.queue(c, tls.createRecord(c, {
        type: tls.ContentType.handshake,
        data: tls.createCertificate(c)
      }));
      if (!c.fail) {
        tls.queue(c, tls.createRecord(c, {
          type: tls.ContentType.handshake,
          data: tls.createServerKeyExchange(c)
        }));
        if (c.verifyClient !== false) {
          tls.queue(c, tls.createRecord(c, {
            type: tls.ContentType.handshake,
            data: tls.createCertificateRequest(c)
          }));
        }
        tls.queue(c, tls.createRecord(c, {
          type: tls.ContentType.handshake,
          data: tls.createServerHelloDone(c)
        }));
      }
    }
    tls.flush(c);
    c.process();
  };
  tls.handleCertificate = function(c, record, length) {
    if (length < 3) {
      return c.error(c, {
        message: "Invalid Certificate message. Message too short.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.illegal_parameter
        }
      });
    }
    var b = record.fragment;
    var msg = {
      certificate_list: readVector(b, 3)
    };
    var cert, asn12;
    var certs = [];
    try {
      while (msg.certificate_list.length() > 0) {
        cert = readVector(msg.certificate_list, 3);
        asn12 = forge2.asn1.fromDer(cert);
        cert = forge2.pki.certificateFromAsn1(asn12, true);
        certs.push(cert);
      }
    } catch (ex) {
      return c.error(c, {
        message: "Could not parse certificate list.",
        cause: ex,
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.bad_certificate
        }
      });
    }
    var client = c.entity === tls.ConnectionEnd.client;
    if ((client || c.verifyClient === true) && certs.length === 0) {
      c.error(c, {
        message: client ? "No server certificate provided." : "No client certificate provided.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.illegal_parameter
        }
      });
    } else if (certs.length === 0) {
      c.expect = client ? SKE : CKE;
    } else {
      if (client) {
        c.session.serverCertificate = certs[0];
      } else {
        c.session.clientCertificate = certs[0];
      }
      if (tls.verifyCertificateChain(c, certs)) {
        c.expect = client ? SKE : CKE;
      }
    }
    c.process();
  };
  tls.handleServerKeyExchange = function(c, record, length) {
    if (length > 0) {
      return c.error(c, {
        message: "Invalid key parameters. Only RSA is supported.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.unsupported_certificate
        }
      });
    }
    c.expect = SCR;
    c.process();
  };
  tls.handleClientKeyExchange = function(c, record, length) {
    if (length < 48) {
      return c.error(c, {
        message: "Invalid key parameters. Only RSA is supported.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.unsupported_certificate
        }
      });
    }
    var b = record.fragment;
    var msg = {
      enc_pre_master_secret: readVector(b, 2).getBytes()
    };
    var privateKey = null;
    if (c.getPrivateKey) {
      try {
        privateKey = c.getPrivateKey(c, c.session.serverCertificate);
        privateKey = forge2.pki.privateKeyFromPem(privateKey);
      } catch (ex) {
        c.error(c, {
          message: "Could not get private key.",
          cause: ex,
          send: true,
          alert: {
            level: tls.Alert.Level.fatal,
            description: tls.Alert.Description.internal_error
          }
        });
      }
    }
    if (privateKey === null) {
      return c.error(c, {
        message: "No private key set.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.internal_error
        }
      });
    }
    try {
      var sp = c.session.sp;
      sp.pre_master_secret = privateKey.decrypt(msg.enc_pre_master_secret);
      var version = c.session.clientHelloVersion;
      if (version.major !== sp.pre_master_secret.charCodeAt(0) || version.minor !== sp.pre_master_secret.charCodeAt(1)) {
        throw new Error("TLS version rollback attack detected.");
      }
    } catch (ex) {
      sp.pre_master_secret = forge2.random.getBytes(48);
    }
    c.expect = CCC;
    if (c.session.clientCertificate !== null) {
      c.expect = CCV;
    }
    c.process();
  };
  tls.handleCertificateRequest = function(c, record, length) {
    if (length < 3) {
      return c.error(c, {
        message: "Invalid CertificateRequest. Message too short.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.illegal_parameter
        }
      });
    }
    var b = record.fragment;
    var msg = {
      certificate_types: readVector(b, 1),
      certificate_authorities: readVector(b, 2)
    };
    c.session.certificateRequest = msg;
    c.expect = SHD;
    c.process();
  };
  tls.handleCertificateVerify = function(c, record, length) {
    if (length < 2) {
      return c.error(c, {
        message: "Invalid CertificateVerify. Message too short.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.illegal_parameter
        }
      });
    }
    var b = record.fragment;
    b.read -= 4;
    var msgBytes = b.bytes();
    b.read += 4;
    var msg = {
      signature: readVector(b, 2).getBytes()
    };
    var verify = forge2.util.createBuffer();
    verify.putBuffer(c.session.md5.digest());
    verify.putBuffer(c.session.sha1.digest());
    verify = verify.getBytes();
    try {
      var cert = c.session.clientCertificate;
      if (!cert.publicKey.verify(verify, msg.signature, "NONE")) {
        throw new Error("CertificateVerify signature does not match.");
      }
      c.session.md5.update(msgBytes);
      c.session.sha1.update(msgBytes);
    } catch (ex) {
      return c.error(c, {
        message: "Bad signature in CertificateVerify.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.handshake_failure
        }
      });
    }
    c.expect = CCC;
    c.process();
  };
  tls.handleServerHelloDone = function(c, record, length) {
    if (length > 0) {
      return c.error(c, {
        message: "Invalid ServerHelloDone message. Invalid length.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.record_overflow
        }
      });
    }
    if (c.serverCertificate === null) {
      var error = {
        message: "No server certificate provided. Not enough security.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.insufficient_security
        }
      };
      var depth = 0;
      var ret = c.verify(c, error.alert.description, depth, []);
      if (ret !== true) {
        if (ret || ret === 0) {
          if (typeof ret === "object" && !forge2.util.isArray(ret)) {
            if (ret.message) {
              error.message = ret.message;
            }
            if (ret.alert) {
              error.alert.description = ret.alert;
            }
          } else if (typeof ret === "number") {
            error.alert.description = ret;
          }
        }
        return c.error(c, error);
      }
    }
    if (c.session.certificateRequest !== null) {
      record = tls.createRecord(c, {
        type: tls.ContentType.handshake,
        data: tls.createCertificate(c)
      });
      tls.queue(c, record);
    }
    record = tls.createRecord(c, {
      type: tls.ContentType.handshake,
      data: tls.createClientKeyExchange(c)
    });
    tls.queue(c, record);
    c.expect = SER;
    var callback = function(c2, signature) {
      if (c2.session.certificateRequest !== null && c2.session.clientCertificate !== null) {
        tls.queue(c2, tls.createRecord(c2, {
          type: tls.ContentType.handshake,
          data: tls.createCertificateVerify(c2, signature)
        }));
      }
      tls.queue(c2, tls.createRecord(c2, {
        type: tls.ContentType.change_cipher_spec,
        data: tls.createChangeCipherSpec()
      }));
      c2.state.pending = tls.createConnectionState(c2);
      c2.state.current.write = c2.state.pending.write;
      tls.queue(c2, tls.createRecord(c2, {
        type: tls.ContentType.handshake,
        data: tls.createFinished(c2)
      }));
      c2.expect = SCC;
      tls.flush(c2);
      c2.process();
    };
    if (c.session.certificateRequest === null || c.session.clientCertificate === null) {
      return callback(c, null);
    }
    tls.getClientSignature(c, callback);
  };
  tls.handleChangeCipherSpec = function(c, record) {
    if (record.fragment.getByte() !== 1) {
      return c.error(c, {
        message: "Invalid ChangeCipherSpec message received.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.illegal_parameter
        }
      });
    }
    var client = c.entity === tls.ConnectionEnd.client;
    if (c.session.resuming && client || !c.session.resuming && !client) {
      c.state.pending = tls.createConnectionState(c);
    }
    c.state.current.read = c.state.pending.read;
    if (!c.session.resuming && client || c.session.resuming && !client) {
      c.state.pending = null;
    }
    c.expect = client ? SFI : CFI;
    c.process();
  };
  tls.handleFinished = function(c, record, length) {
    var b = record.fragment;
    b.read -= 4;
    var msgBytes = b.bytes();
    b.read += 4;
    var vd = record.fragment.getBytes();
    b = forge2.util.createBuffer();
    b.putBuffer(c.session.md5.digest());
    b.putBuffer(c.session.sha1.digest());
    var client = c.entity === tls.ConnectionEnd.client;
    var label = client ? "server finished" : "client finished";
    var sp = c.session.sp;
    var vdl = 12;
    var prf = prf_TLS1;
    b = prf(sp.master_secret, label, b.getBytes(), vdl);
    if (b.getBytes() !== vd) {
      return c.error(c, {
        message: "Invalid verify_data in Finished message.",
        send: true,
        alert: {
          level: tls.Alert.Level.fatal,
          description: tls.Alert.Description.decrypt_error
        }
      });
    }
    c.session.md5.update(msgBytes);
    c.session.sha1.update(msgBytes);
    if (c.session.resuming && client || !c.session.resuming && !client) {
      tls.queue(c, tls.createRecord(c, {
        type: tls.ContentType.change_cipher_spec,
        data: tls.createChangeCipherSpec()
      }));
      c.state.current.write = c.state.pending.write;
      c.state.pending = null;
      tls.queue(c, tls.createRecord(c, {
        type: tls.ContentType.handshake,
        data: tls.createFinished(c)
      }));
    }
    c.expect = client ? SAD : CAD;
    c.handshaking = false;
    ++c.handshakes;
    c.peerCertificate = client ? c.session.serverCertificate : c.session.clientCertificate;
    tls.flush(c);
    c.isConnected = true;
    c.connected(c);
    c.process();
  };
  tls.handleAlert = function(c, record) {
    var b = record.fragment;
    var alert = {
      level: b.getByte(),
      description: b.getByte()
    };
    var msg;
    switch (alert.description) {
      case tls.Alert.Description.close_notify:
        msg = "Connection closed.";
        break;
      case tls.Alert.Description.unexpected_message:
        msg = "Unexpected message.";
        break;
      case tls.Alert.Description.bad_record_mac:
        msg = "Bad record MAC.";
        break;
      case tls.Alert.Description.decryption_failed:
        msg = "Decryption failed.";
        break;
      case tls.Alert.Description.record_overflow:
        msg = "Record overflow.";
        break;
      case tls.Alert.Description.decompression_failure:
        msg = "Decompression failed.";
        break;
      case tls.Alert.Description.handshake_failure:
        msg = "Handshake failure.";
        break;
      case tls.Alert.Description.bad_certificate:
        msg = "Bad certificate.";
        break;
      case tls.Alert.Description.unsupported_certificate:
        msg = "Unsupported certificate.";
        break;
      case tls.Alert.Description.certificate_revoked:
        msg = "Certificate revoked.";
        break;
      case tls.Alert.Description.certificate_expired:
        msg = "Certificate expired.";
        break;
      case tls.Alert.Description.certificate_unknown:
        msg = "Certificate unknown.";
        break;
      case tls.Alert.Description.illegal_parameter:
        msg = "Illegal parameter.";
        break;
      case tls.Alert.Description.unknown_ca:
        msg = "Unknown certificate authority.";
        break;
      case tls.Alert.Description.access_denied:
        msg = "Access denied.";
        break;
      case tls.Alert.Description.decode_error:
        msg = "Decode error.";
        break;
      case tls.Alert.Description.decrypt_error:
        msg = "Decrypt error.";
        break;
      case tls.Alert.Description.export_restriction:
        msg = "Export restriction.";
        break;
      case tls.Alert.Description.protocol_version:
        msg = "Unsupported protocol version.";
        break;
      case tls.Alert.Description.insufficient_security:
        msg = "Insufficient security.";
        break;
      case tls.Alert.Description.internal_error:
        msg = "Internal error.";
        break;
      case tls.Alert.Description.user_canceled:
        msg = "User canceled.";
        break;
      case tls.Alert.Description.no_renegotiation:
        msg = "Renegotiation not supported.";
        break;
      default:
        msg = "Unknown error.";
        break;
    }
    if (alert.description === tls.Alert.Description.close_notify) {
      return c.close();
    }
    c.error(c, {
      message: msg,
      send: false,
      // origin is the opposite end
      origin: c.entity === tls.ConnectionEnd.client ? "server" : "client",
      alert
    });
    c.process();
  };
  tls.handleHandshake = function(c, record) {
    var b = record.fragment;
    var type = b.getByte();
    var length = b.getInt24();
    if (length > b.length()) {
      c.fragmented = record;
      record.fragment = forge2.util.createBuffer();
      b.read -= 4;
      return c.process();
    }
    c.fragmented = null;
    b.read -= 4;
    var bytes = b.bytes(length + 4);
    b.read += 4;
    if (type in hsTable[c.entity][c.expect]) {
      if (c.entity === tls.ConnectionEnd.server && !c.open && !c.fail) {
        c.handshaking = true;
        c.session = {
          version: null,
          extensions: {
            server_name: {
              serverNameList: []
            }
          },
          cipherSuite: null,
          compressionMethod: null,
          serverCertificate: null,
          clientCertificate: null,
          md5: forge2.md.md5.create(),
          sha1: forge2.md.sha1.create()
        };
      }
      if (type !== tls.HandshakeType.hello_request && type !== tls.HandshakeType.certificate_verify && type !== tls.HandshakeType.finished) {
        c.session.md5.update(bytes);
        c.session.sha1.update(bytes);
      }
      hsTable[c.entity][c.expect][type](c, record, length);
    } else {
      tls.handleUnexpected(c, record);
    }
  };
  tls.handleApplicationData = function(c, record) {
    c.data.putBuffer(record.fragment);
    c.dataReady(c);
    c.process();
  };
  tls.handleHeartbeat = function(c, record) {
    var b = record.fragment;
    var type = b.getByte();
    var length = b.getInt16();
    var payload = b.getBytes(length);
    if (type === tls.HeartbeatMessageType.heartbeat_request) {
      if (c.handshaking || length > payload.length) {
        return c.process();
      }
      tls.queue(c, tls.createRecord(c, {
        type: tls.ContentType.heartbeat,
        data: tls.createHeartbeat(
          tls.HeartbeatMessageType.heartbeat_response,
          payload
        )
      }));
      tls.flush(c);
    } else if (type === tls.HeartbeatMessageType.heartbeat_response) {
      if (payload !== c.expectedHeartbeatPayload) {
        return c.process();
      }
      if (c.heartbeatReceived) {
        c.heartbeatReceived(c, forge2.util.createBuffer(payload));
      }
    }
    c.process();
  };
  var SHE = 0;
  var SCE = 1;
  var SKE = 2;
  var SCR = 3;
  var SHD = 4;
  var SCC = 5;
  var SFI = 6;
  var SAD = 7;
  var SER = 8;
  var CHE = 0;
  var CCE = 1;
  var CKE = 2;
  var CCV = 3;
  var CCC = 4;
  var CFI = 5;
  var CAD = 6;
  var __ = tls.handleUnexpected;
  var R0 = tls.handleChangeCipherSpec;
  var R1 = tls.handleAlert;
  var R2 = tls.handleHandshake;
  var R3 = tls.handleApplicationData;
  var R4 = tls.handleHeartbeat;
  var ctTable = [];
  ctTable[tls.ConnectionEnd.client] = [
    //      CC,AL,HS,AD,HB
    /*SHE*/
    [__, R1, R2, __, R4],
    /*SCE*/
    [__, R1, R2, __, R4],
    /*SKE*/
    [__, R1, R2, __, R4],
    /*SCR*/
    [__, R1, R2, __, R4],
    /*SHD*/
    [__, R1, R2, __, R4],
    /*SCC*/
    [R0, R1, __, __, R4],
    /*SFI*/
    [__, R1, R2, __, R4],
    /*SAD*/
    [__, R1, R2, R3, R4],
    /*SER*/
    [__, R1, R2, __, R4]
  ];
  ctTable[tls.ConnectionEnd.server] = [
    //      CC,AL,HS,AD
    /*CHE*/
    [__, R1, R2, __, R4],
    /*CCE*/
    [__, R1, R2, __, R4],
    /*CKE*/
    [__, R1, R2, __, R4],
    /*CCV*/
    [__, R1, R2, __, R4],
    /*CCC*/
    [R0, R1, __, __, R4],
    /*CFI*/
    [__, R1, R2, __, R4],
    /*CAD*/
    [__, R1, R2, R3, R4],
    /*CER*/
    [__, R1, R2, __, R4]
  ];
  var H0 = tls.handleHelloRequest;
  var H1 = tls.handleServerHello;
  var H2 = tls.handleCertificate;
  var H3 = tls.handleServerKeyExchange;
  var H4 = tls.handleCertificateRequest;
  var H5 = tls.handleServerHelloDone;
  var H6 = tls.handleFinished;
  var hsTable = [];
  hsTable[tls.ConnectionEnd.client] = [
    //      HR,01,SH,03,04,05,06,07,08,09,10,SC,SK,CR,HD,15,CK,17,18,19,FI
    /*SHE*/
    [__, __, H1, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __],
    /*SCE*/
    [H0, __, __, __, __, __, __, __, __, __, __, H2, H3, H4, H5, __, __, __, __, __, __],
    /*SKE*/
    [H0, __, __, __, __, __, __, __, __, __, __, __, H3, H4, H5, __, __, __, __, __, __],
    /*SCR*/
    [H0, __, __, __, __, __, __, __, __, __, __, __, __, H4, H5, __, __, __, __, __, __],
    /*SHD*/
    [H0, __, __, __, __, __, __, __, __, __, __, __, __, __, H5, __, __, __, __, __, __],
    /*SCC*/
    [H0, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __],
    /*SFI*/
    [H0, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, H6],
    /*SAD*/
    [H0, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __],
    /*SER*/
    [H0, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __]
  ];
  var H7 = tls.handleClientHello;
  var H8 = tls.handleClientKeyExchange;
  var H9 = tls.handleCertificateVerify;
  hsTable[tls.ConnectionEnd.server] = [
    //      01,CH,02,03,04,05,06,07,08,09,10,CC,12,13,14,CV,CK,17,18,19,FI
    /*CHE*/
    [__, H7, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __],
    /*CCE*/
    [__, __, __, __, __, __, __, __, __, __, __, H2, __, __, __, __, __, __, __, __, __],
    /*CKE*/
    [__, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, H8, __, __, __, __],
    /*CCV*/
    [__, __, __, __, __, __, __, __, __, __, __, __, __, __, __, H9, __, __, __, __, __],
    /*CCC*/
    [__, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __],
    /*CFI*/
    [__, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, H6],
    /*CAD*/
    [__, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __],
    /*CER*/
    [__, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __]
  ];
  tls.generateKeys = function(c, sp) {
    var prf = prf_TLS1;
    var random2 = sp.client_random + sp.server_random;
    if (!c.session.resuming) {
      sp.master_secret = prf(
        sp.pre_master_secret,
        "master secret",
        random2,
        48
      ).bytes();
      sp.pre_master_secret = null;
    }
    random2 = sp.server_random + sp.client_random;
    var length = 2 * sp.mac_key_length + 2 * sp.enc_key_length;
    var tls10 = c.version.major === tls.Versions.TLS_1_0.major && c.version.minor === tls.Versions.TLS_1_0.minor;
    if (tls10) {
      length += 2 * sp.fixed_iv_length;
    }
    var km = prf(sp.master_secret, "key expansion", random2, length);
    var rval = {
      client_write_MAC_key: km.getBytes(sp.mac_key_length),
      server_write_MAC_key: km.getBytes(sp.mac_key_length),
      client_write_key: km.getBytes(sp.enc_key_length),
      server_write_key: km.getBytes(sp.enc_key_length)
    };
    if (tls10) {
      rval.client_write_IV = km.getBytes(sp.fixed_iv_length);
      rval.server_write_IV = km.getBytes(sp.fixed_iv_length);
    }
    return rval;
  };
  tls.createConnectionState = function(c) {
    var client = c.entity === tls.ConnectionEnd.client;
    var createMode = function() {
      var mode = {
        // two 32-bit numbers, first is most significant
        sequenceNumber: [0, 0],
        macKey: null,
        macLength: 0,
        macFunction: null,
        cipherState: null,
        cipherFunction: function(record) {
          return true;
        },
        compressionState: null,
        compressFunction: function(record) {
          return true;
        },
        updateSequenceNumber: function() {
          if (mode.sequenceNumber[1] === 4294967295) {
            mode.sequenceNumber[1] = 0;
            ++mode.sequenceNumber[0];
          } else {
            ++mode.sequenceNumber[1];
          }
        }
      };
      return mode;
    };
    var state = {
      read: createMode(),
      write: createMode()
    };
    state.read.update = function(c2, record) {
      if (!state.read.cipherFunction(record, state.read)) {
        c2.error(c2, {
          message: "Could not decrypt record or bad MAC.",
          send: true,
          alert: {
            level: tls.Alert.Level.fatal,
            // doesn't matter if decryption failed or MAC was
            // invalid, return the same error so as not to reveal
            // which one occurred
            description: tls.Alert.Description.bad_record_mac
          }
        });
      } else if (!state.read.compressFunction(c2, record, state.read)) {
        c2.error(c2, {
          message: "Could not decompress record.",
          send: true,
          alert: {
            level: tls.Alert.Level.fatal,
            description: tls.Alert.Description.decompression_failure
          }
        });
      }
      return !c2.fail;
    };
    state.write.update = function(c2, record) {
      if (!state.write.compressFunction(c2, record, state.write)) {
        c2.error(c2, {
          message: "Could not compress record.",
          send: false,
          alert: {
            level: tls.Alert.Level.fatal,
            description: tls.Alert.Description.internal_error
          }
        });
      } else if (!state.write.cipherFunction(record, state.write)) {
        c2.error(c2, {
          message: "Could not encrypt record.",
          send: false,
          alert: {
            level: tls.Alert.Level.fatal,
            description: tls.Alert.Description.internal_error
          }
        });
      }
      return !c2.fail;
    };
    if (c.session) {
      var sp = c.session.sp;
      c.session.cipherSuite.initSecurityParameters(sp);
      sp.keys = tls.generateKeys(c, sp);
      state.read.macKey = client ? sp.keys.server_write_MAC_key : sp.keys.client_write_MAC_key;
      state.write.macKey = client ? sp.keys.client_write_MAC_key : sp.keys.server_write_MAC_key;
      c.session.cipherSuite.initConnectionState(state, c, sp);
      switch (sp.compression_algorithm) {
        case tls.CompressionMethod.none:
          break;
        case tls.CompressionMethod.deflate:
          state.read.compressFunction = inflate;
          state.write.compressFunction = deflate;
          break;
        default:
          throw new Error("Unsupported compression algorithm.");
      }
    }
    return state;
  };
  tls.createRandom = function() {
    var d = /* @__PURE__ */ new Date();
    var utc = +d + d.getTimezoneOffset() * 6e4;
    var rval = forge2.util.createBuffer();
    rval.putInt32(utc);
    rval.putBytes(forge2.random.getBytes(28));
    return rval;
  };
  tls.createRecord = function(c, options) {
    if (!options.data) {
      return null;
    }
    var record = {
      type: options.type,
      version: {
        major: c.version.major,
        minor: c.version.minor
      },
      length: options.data.length(),
      fragment: options.data
    };
    return record;
  };
  tls.createAlert = function(c, alert) {
    var b = forge2.util.createBuffer();
    b.putByte(alert.level);
    b.putByte(alert.description);
    return tls.createRecord(c, {
      type: tls.ContentType.alert,
      data: b
    });
  };
  tls.createClientHello = function(c) {
    c.session.clientHelloVersion = {
      major: c.version.major,
      minor: c.version.minor
    };
    var cipherSuites = forge2.util.createBuffer();
    for (var i = 0; i < c.cipherSuites.length; ++i) {
      var cs = c.cipherSuites[i];
      cipherSuites.putByte(cs.id[0]);
      cipherSuites.putByte(cs.id[1]);
    }
    var cSuites = cipherSuites.length();
    var compressionMethods = forge2.util.createBuffer();
    compressionMethods.putByte(tls.CompressionMethod.none);
    var cMethods = compressionMethods.length();
    var extensions = forge2.util.createBuffer();
    if (c.virtualHost) {
      var ext = forge2.util.createBuffer();
      ext.putByte(0);
      ext.putByte(0);
      var serverName = forge2.util.createBuffer();
      serverName.putByte(0);
      writeVector(serverName, 2, forge2.util.createBuffer(c.virtualHost));
      var snList = forge2.util.createBuffer();
      writeVector(snList, 2, serverName);
      writeVector(ext, 2, snList);
      extensions.putBuffer(ext);
    }
    var extLength = extensions.length();
    if (extLength > 0) {
      extLength += 2;
    }
    var sessionId = c.session.id;
    var length = sessionId.length + 1 + // session ID vector
    2 + // version (major + minor)
    4 + 28 + // random time and random bytes
    2 + cSuites + // cipher suites vector
    1 + cMethods + // compression methods vector
    extLength;
    var rval = forge2.util.createBuffer();
    rval.putByte(tls.HandshakeType.client_hello);
    rval.putInt24(length);
    rval.putByte(c.version.major);
    rval.putByte(c.version.minor);
    rval.putBytes(c.session.sp.client_random);
    writeVector(rval, 1, forge2.util.createBuffer(sessionId));
    writeVector(rval, 2, cipherSuites);
    writeVector(rval, 1, compressionMethods);
    if (extLength > 0) {
      writeVector(rval, 2, extensions);
    }
    return rval;
  };
  tls.createServerHello = function(c) {
    var sessionId = c.session.id;
    var length = sessionId.length + 1 + // session ID vector
    2 + // version (major + minor)
    4 + 28 + // random time and random bytes
    2 + // chosen cipher suite
    1;
    var rval = forge2.util.createBuffer();
    rval.putByte(tls.HandshakeType.server_hello);
    rval.putInt24(length);
    rval.putByte(c.version.major);
    rval.putByte(c.version.minor);
    rval.putBytes(c.session.sp.server_random);
    writeVector(rval, 1, forge2.util.createBuffer(sessionId));
    rval.putByte(c.session.cipherSuite.id[0]);
    rval.putByte(c.session.cipherSuite.id[1]);
    rval.putByte(c.session.compressionMethod);
    return rval;
  };
  tls.createCertificate = function(c) {
    var client = c.entity === tls.ConnectionEnd.client;
    var cert = null;
    if (c.getCertificate) {
      var hint;
      if (client) {
        hint = c.session.certificateRequest;
      } else {
        hint = c.session.extensions.server_name.serverNameList;
      }
      cert = c.getCertificate(c, hint);
    }
    var certList = forge2.util.createBuffer();
    if (cert !== null) {
      try {
        if (!forge2.util.isArray(cert)) {
          cert = [cert];
        }
        var asn12 = null;
        for (var i = 0; i < cert.length; ++i) {
          var msg = forge2.pem.decode(cert[i])[0];
          if (msg.type !== "CERTIFICATE" && msg.type !== "X509 CERTIFICATE" && msg.type !== "TRUSTED CERTIFICATE") {
            var error = new Error('Could not convert certificate from PEM; PEM header type is not "CERTIFICATE", "X509 CERTIFICATE", or "TRUSTED CERTIFICATE".');
            error.headerType = msg.type;
            throw error;
          }
          if (msg.procType && msg.procType.type === "ENCRYPTED") {
            throw new Error("Could not convert certificate from PEM; PEM is encrypted.");
          }
          var der = forge2.util.createBuffer(msg.body);
          if (asn12 === null) {
            asn12 = forge2.asn1.fromDer(der.bytes(), false);
          }
          var certBuffer = forge2.util.createBuffer();
          writeVector(certBuffer, 3, der);
          certList.putBuffer(certBuffer);
        }
        cert = forge2.pki.certificateFromAsn1(asn12);
        if (client) {
          c.session.clientCertificate = cert;
        } else {
          c.session.serverCertificate = cert;
        }
      } catch (ex) {
        return c.error(c, {
          message: "Could not send certificate list.",
          cause: ex,
          send: true,
          alert: {
            level: tls.Alert.Level.fatal,
            description: tls.Alert.Description.bad_certificate
          }
        });
      }
    }
    var length = 3 + certList.length();
    var rval = forge2.util.createBuffer();
    rval.putByte(tls.HandshakeType.certificate);
    rval.putInt24(length);
    writeVector(rval, 3, certList);
    return rval;
  };
  tls.createClientKeyExchange = function(c) {
    var b = forge2.util.createBuffer();
    b.putByte(c.session.clientHelloVersion.major);
    b.putByte(c.session.clientHelloVersion.minor);
    b.putBytes(forge2.random.getBytes(46));
    var sp = c.session.sp;
    sp.pre_master_secret = b.getBytes();
    var key2 = c.session.serverCertificate.publicKey;
    b = key2.encrypt(sp.pre_master_secret);
    var length = b.length + 2;
    var rval = forge2.util.createBuffer();
    rval.putByte(tls.HandshakeType.client_key_exchange);
    rval.putInt24(length);
    rval.putInt16(b.length);
    rval.putBytes(b);
    return rval;
  };
  tls.createServerKeyExchange = function(c) {
    var rval = forge2.util.createBuffer();
    return rval;
  };
  tls.getClientSignature = function(c, callback) {
    var b = forge2.util.createBuffer();
    b.putBuffer(c.session.md5.digest());
    b.putBuffer(c.session.sha1.digest());
    b = b.getBytes();
    c.getSignature = c.getSignature || function(c2, b2, callback2) {
      var privateKey = null;
      if (c2.getPrivateKey) {
        try {
          privateKey = c2.getPrivateKey(c2, c2.session.clientCertificate);
          privateKey = forge2.pki.privateKeyFromPem(privateKey);
        } catch (ex) {
          c2.error(c2, {
            message: "Could not get private key.",
            cause: ex,
            send: true,
            alert: {
              level: tls.Alert.Level.fatal,
              description: tls.Alert.Description.internal_error
            }
          });
        }
      }
      if (privateKey === null) {
        c2.error(c2, {
          message: "No private key set.",
          send: true,
          alert: {
            level: tls.Alert.Level.fatal,
            description: tls.Alert.Description.internal_error
          }
        });
      } else {
        b2 = privateKey.sign(b2, null);
      }
      callback2(c2, b2);
    };
    c.getSignature(c, b, callback);
  };
  tls.createCertificateVerify = function(c, signature) {
    var length = signature.length + 2;
    var rval = forge2.util.createBuffer();
    rval.putByte(tls.HandshakeType.certificate_verify);
    rval.putInt24(length);
    rval.putInt16(signature.length);
    rval.putBytes(signature);
    return rval;
  };
  tls.createCertificateRequest = function(c) {
    var certTypes = forge2.util.createBuffer();
    certTypes.putByte(1);
    var cAs = forge2.util.createBuffer();
    for (var key2 in c.caStore.certs) {
      var cert = c.caStore.certs[key2];
      var dn = forge2.pki.distinguishedNameToAsn1(cert.subject);
      var byteBuffer = forge2.asn1.toDer(dn);
      cAs.putInt16(byteBuffer.length());
      cAs.putBuffer(byteBuffer);
    }
    var length = 1 + certTypes.length() + 2 + cAs.length();
    var rval = forge2.util.createBuffer();
    rval.putByte(tls.HandshakeType.certificate_request);
    rval.putInt24(length);
    writeVector(rval, 1, certTypes);
    writeVector(rval, 2, cAs);
    return rval;
  };
  tls.createServerHelloDone = function(c) {
    var rval = forge2.util.createBuffer();
    rval.putByte(tls.HandshakeType.server_hello_done);
    rval.putInt24(0);
    return rval;
  };
  tls.createChangeCipherSpec = function() {
    var rval = forge2.util.createBuffer();
    rval.putByte(1);
    return rval;
  };
  tls.createFinished = function(c) {
    var b = forge2.util.createBuffer();
    b.putBuffer(c.session.md5.digest());
    b.putBuffer(c.session.sha1.digest());
    var client = c.entity === tls.ConnectionEnd.client;
    var sp = c.session.sp;
    var vdl = 12;
    var prf = prf_TLS1;
    var label = client ? "client finished" : "server finished";
    b = prf(sp.master_secret, label, b.getBytes(), vdl);
    var rval = forge2.util.createBuffer();
    rval.putByte(tls.HandshakeType.finished);
    rval.putInt24(b.length());
    rval.putBuffer(b);
    return rval;
  };
  tls.createHeartbeat = function(type, payload, payloadLength) {
    if (typeof payloadLength === "undefined") {
      payloadLength = payload.length;
    }
    var rval = forge2.util.createBuffer();
    rval.putByte(type);
    rval.putInt16(payloadLength);
    rval.putBytes(payload);
    var plaintextLength = rval.length();
    var paddingLength = Math.max(16, plaintextLength - payloadLength - 3);
    rval.putBytes(forge2.random.getBytes(paddingLength));
    return rval;
  };
  tls.queue = function(c, record) {
    if (!record) {
      return;
    }
    if (record.fragment.length() === 0) {
      if (record.type === tls.ContentType.handshake || record.type === tls.ContentType.alert || record.type === tls.ContentType.change_cipher_spec) {
        return;
      }
    }
    if (record.type === tls.ContentType.handshake) {
      var bytes = record.fragment.bytes();
      c.session.md5.update(bytes);
      c.session.sha1.update(bytes);
      bytes = null;
    }
    var records;
    if (record.fragment.length() <= tls.MaxFragment) {
      records = [record];
    } else {
      records = [];
      var data = record.fragment.bytes();
      while (data.length > tls.MaxFragment) {
        records.push(tls.createRecord(c, {
          type: record.type,
          data: forge2.util.createBuffer(data.slice(0, tls.MaxFragment))
        }));
        data = data.slice(tls.MaxFragment);
      }
      if (data.length > 0) {
        records.push(tls.createRecord(c, {
          type: record.type,
          data: forge2.util.createBuffer(data)
        }));
      }
    }
    for (var i = 0; i < records.length && !c.fail; ++i) {
      var rec = records[i];
      var s = c.state.current.write;
      if (s.update(c, rec)) {
        c.records.push(rec);
      }
    }
  };
  tls.flush = function(c) {
    for (var i = 0; i < c.records.length; ++i) {
      var record = c.records[i];
      c.tlsData.putByte(record.type);
      c.tlsData.putByte(record.version.major);
      c.tlsData.putByte(record.version.minor);
      c.tlsData.putInt16(record.fragment.length());
      c.tlsData.putBuffer(c.records[i].fragment);
    }
    c.records = [];
    return c.tlsDataReady(c);
  };
  var _certErrorToAlertDesc = function(error) {
    switch (error) {
      case true:
        return true;
      case forge2.pki.certificateError.bad_certificate:
        return tls.Alert.Description.bad_certificate;
      case forge2.pki.certificateError.unsupported_certificate:
        return tls.Alert.Description.unsupported_certificate;
      case forge2.pki.certificateError.certificate_revoked:
        return tls.Alert.Description.certificate_revoked;
      case forge2.pki.certificateError.certificate_expired:
        return tls.Alert.Description.certificate_expired;
      case forge2.pki.certificateError.certificate_unknown:
        return tls.Alert.Description.certificate_unknown;
      case forge2.pki.certificateError.unknown_ca:
        return tls.Alert.Description.unknown_ca;
      default:
        return tls.Alert.Description.bad_certificate;
    }
  };
  var _alertDescToCertError = function(desc) {
    switch (desc) {
      case true:
        return true;
      case tls.Alert.Description.bad_certificate:
        return forge2.pki.certificateError.bad_certificate;
      case tls.Alert.Description.unsupported_certificate:
        return forge2.pki.certificateError.unsupported_certificate;
      case tls.Alert.Description.certificate_revoked:
        return forge2.pki.certificateError.certificate_revoked;
      case tls.Alert.Description.certificate_expired:
        return forge2.pki.certificateError.certificate_expired;
      case tls.Alert.Description.certificate_unknown:
        return forge2.pki.certificateError.certificate_unknown;
      case tls.Alert.Description.unknown_ca:
        return forge2.pki.certificateError.unknown_ca;
      default:
        return forge2.pki.certificateError.bad_certificate;
    }
  };
  tls.verifyCertificateChain = function(c, chain) {
    try {
      var options = {};
      for (var key2 in c.verifyOptions) {
        options[key2] = c.verifyOptions[key2];
      }
      options.verify = function(vfd, depth, chain2) {
        var desc = _certErrorToAlertDesc(vfd);
        var ret = c.verify(c, vfd, depth, chain2);
        if (ret !== true) {
          if (typeof ret === "object" && !forge2.util.isArray(ret)) {
            var error = new Error("The application rejected the certificate.");
            error.send = true;
            error.alert = {
              level: tls.Alert.Level.fatal,
              description: tls.Alert.Description.bad_certificate
            };
            if (ret.message) {
              error.message = ret.message;
            }
            if (ret.alert) {
              error.alert.description = ret.alert;
            }
            throw error;
          }
          if (ret !== vfd) {
            ret = _alertDescToCertError(ret);
          }
        }
        return ret;
      };
      forge2.pki.verifyCertificateChain(c.caStore, chain, options);
    } catch (ex) {
      var err = ex;
      if (typeof err !== "object" || forge2.util.isArray(err)) {
        err = {
          send: true,
          alert: {
            level: tls.Alert.Level.fatal,
            description: _certErrorToAlertDesc(ex)
          }
        };
      }
      if (!("send" in err)) {
        err.send = true;
      }
      if (!("alert" in err)) {
        err.alert = {
          level: tls.Alert.Level.fatal,
          description: _certErrorToAlertDesc(err.error)
        };
      }
      c.error(c, err);
    }
    return !c.fail;
  };
  tls.createSessionCache = function(cache, capacity) {
    var rval = null;
    if (cache && cache.getSession && cache.setSession && cache.order) {
      rval = cache;
    } else {
      rval = {};
      rval.cache = cache || {};
      rval.capacity = Math.max(capacity || 100, 1);
      rval.order = [];
      for (var key2 in cache) {
        if (rval.order.length <= capacity) {
          rval.order.push(key2);
        } else {
          delete cache[key2];
        }
      }
      rval.getSession = function(sessionId) {
        var session = null;
        var key3 = null;
        if (sessionId) {
          key3 = forge2.util.bytesToHex(sessionId);
        } else if (rval.order.length > 0) {
          key3 = rval.order[0];
        }
        if (key3 !== null && key3 in rval.cache) {
          session = rval.cache[key3];
          delete rval.cache[key3];
          for (var i in rval.order) {
            if (rval.order[i] === key3) {
              rval.order.splice(i, 1);
              break;
            }
          }
        }
        return session;
      };
      rval.setSession = function(sessionId, session) {
        if (rval.order.length === rval.capacity) {
          var key3 = rval.order.shift();
          delete rval.cache[key3];
        }
        var key3 = forge2.util.bytesToHex(sessionId);
        rval.order.push(key3);
        rval.cache[key3] = session;
      };
    }
    return rval;
  };
  tls.createConnection = function(options) {
    var caStore = null;
    if (options.caStore) {
      if (forge2.util.isArray(options.caStore)) {
        caStore = forge2.pki.createCaStore(options.caStore);
      } else {
        caStore = options.caStore;
      }
    } else {
      caStore = forge2.pki.createCaStore();
    }
    var cipherSuites = options.cipherSuites || null;
    if (cipherSuites === null) {
      cipherSuites = [];
      for (var key2 in tls.CipherSuites) {
        cipherSuites.push(tls.CipherSuites[key2]);
      }
    }
    var entity = options.server || false ? tls.ConnectionEnd.server : tls.ConnectionEnd.client;
    var sessionCache = options.sessionCache ? tls.createSessionCache(options.sessionCache) : null;
    var c = {
      version: { major: tls.Version.major, minor: tls.Version.minor },
      entity,
      sessionId: options.sessionId,
      caStore,
      sessionCache,
      cipherSuites,
      connected: options.connected,
      virtualHost: options.virtualHost || null,
      verifyClient: options.verifyClient || false,
      verify: options.verify || function(cn, vfd, dpth, cts) {
        return vfd;
      },
      verifyOptions: options.verifyOptions || {},
      getCertificate: options.getCertificate || null,
      getPrivateKey: options.getPrivateKey || null,
      getSignature: options.getSignature || null,
      input: forge2.util.createBuffer(),
      tlsData: forge2.util.createBuffer(),
      data: forge2.util.createBuffer(),
      tlsDataReady: options.tlsDataReady,
      dataReady: options.dataReady,
      heartbeatReceived: options.heartbeatReceived,
      closed: options.closed,
      error: function(c2, ex) {
        ex.origin = ex.origin || (c2.entity === tls.ConnectionEnd.client ? "client" : "server");
        if (ex.send) {
          tls.queue(c2, tls.createAlert(c2, ex.alert));
          tls.flush(c2);
        }
        var fatal = ex.fatal !== false;
        if (fatal) {
          c2.fail = true;
        }
        options.error(c2, ex);
        if (fatal) {
          c2.close(false);
        }
      },
      deflate: options.deflate || null,
      inflate: options.inflate || null
    };
    c.reset = function(clearFail) {
      c.version = { major: tls.Version.major, minor: tls.Version.minor };
      c.record = null;
      c.session = null;
      c.peerCertificate = null;
      c.state = {
        pending: null,
        current: null
      };
      c.expect = c.entity === tls.ConnectionEnd.client ? SHE : CHE;
      c.fragmented = null;
      c.records = [];
      c.open = false;
      c.handshakes = 0;
      c.handshaking = false;
      c.isConnected = false;
      c.fail = !(clearFail || typeof clearFail === "undefined");
      c.input.clear();
      c.tlsData.clear();
      c.data.clear();
      c.state.current = tls.createConnectionState(c);
    };
    c.reset();
    var _update = function(c2, record) {
      var aligned = record.type - tls.ContentType.change_cipher_spec;
      var handlers = ctTable[c2.entity][c2.expect];
      if (aligned in handlers) {
        handlers[aligned](c2, record);
      } else {
        tls.handleUnexpected(c2, record);
      }
    };
    var _readRecordHeader = function(c2) {
      var rval = 0;
      var b = c2.input;
      var len = b.length();
      if (len < 5) {
        rval = 5 - len;
      } else {
        c2.record = {
          type: b.getByte(),
          version: {
            major: b.getByte(),
            minor: b.getByte()
          },
          length: b.getInt16(),
          fragment: forge2.util.createBuffer(),
          ready: false
        };
        var compatibleVersion = c2.record.version.major === c2.version.major;
        if (compatibleVersion && c2.session && c2.session.version) {
          compatibleVersion = c2.record.version.minor === c2.version.minor;
        }
        if (!compatibleVersion) {
          c2.error(c2, {
            message: "Incompatible TLS version.",
            send: true,
            alert: {
              level: tls.Alert.Level.fatal,
              description: tls.Alert.Description.protocol_version
            }
          });
        }
      }
      return rval;
    };
    var _readRecord = function(c2) {
      var rval = 0;
      var b = c2.input;
      var len = b.length();
      if (len < c2.record.length) {
        rval = c2.record.length - len;
      } else {
        c2.record.fragment.putBytes(b.getBytes(c2.record.length));
        b.compact();
        var s = c2.state.current.read;
        if (s.update(c2, c2.record)) {
          if (c2.fragmented !== null) {
            if (c2.fragmented.type === c2.record.type) {
              c2.fragmented.fragment.putBuffer(c2.record.fragment);
              c2.record = c2.fragmented;
            } else {
              c2.error(c2, {
                message: "Invalid fragmented record.",
                send: true,
                alert: {
                  level: tls.Alert.Level.fatal,
                  description: tls.Alert.Description.unexpected_message
                }
              });
            }
          }
          c2.record.ready = true;
        }
      }
      return rval;
    };
    c.handshake = function(sessionId) {
      if (c.entity !== tls.ConnectionEnd.client) {
        c.error(c, {
          message: "Cannot initiate handshake as a server.",
          fatal: false
        });
      } else if (c.handshaking) {
        c.error(c, {
          message: "Handshake already in progress.",
          fatal: false
        });
      } else {
        if (c.fail && !c.open && c.handshakes === 0) {
          c.fail = false;
        }
        c.handshaking = true;
        sessionId = sessionId || "";
        var session = null;
        if (sessionId.length > 0) {
          if (c.sessionCache) {
            session = c.sessionCache.getSession(sessionId);
          }
          if (session === null) {
            sessionId = "";
          }
        }
        if (sessionId.length === 0 && c.sessionCache) {
          session = c.sessionCache.getSession();
          if (session !== null) {
            sessionId = session.id;
          }
        }
        c.session = {
          id: sessionId,
          version: null,
          cipherSuite: null,
          compressionMethod: null,
          serverCertificate: null,
          certificateRequest: null,
          clientCertificate: null,
          sp: {},
          md5: forge2.md.md5.create(),
          sha1: forge2.md.sha1.create()
        };
        if (session) {
          c.version = session.version;
          c.session.sp = session.sp;
        }
        c.session.sp.client_random = tls.createRandom().getBytes();
        c.open = true;
        tls.queue(c, tls.createRecord(c, {
          type: tls.ContentType.handshake,
          data: tls.createClientHello(c)
        }));
        tls.flush(c);
      }
    };
    c.process = function(data) {
      var rval = 0;
      if (data) {
        c.input.putBytes(data);
      }
      if (!c.fail) {
        if (c.record !== null && c.record.ready && c.record.fragment.isEmpty()) {
          c.record = null;
        }
        if (c.record === null) {
          rval = _readRecordHeader(c);
        }
        if (!c.fail && c.record !== null && !c.record.ready) {
          rval = _readRecord(c);
        }
        if (!c.fail && c.record !== null && c.record.ready) {
          _update(c, c.record);
        }
      }
      return rval;
    };
    c.prepare = function(data) {
      tls.queue(c, tls.createRecord(c, {
        type: tls.ContentType.application_data,
        data: forge2.util.createBuffer(data)
      }));
      return tls.flush(c);
    };
    c.prepareHeartbeatRequest = function(payload, payloadLength) {
      if (payload instanceof forge2.util.ByteBuffer) {
        payload = payload.bytes();
      }
      if (typeof payloadLength === "undefined") {
        payloadLength = payload.length;
      }
      c.expectedHeartbeatPayload = payload;
      tls.queue(c, tls.createRecord(c, {
        type: tls.ContentType.heartbeat,
        data: tls.createHeartbeat(
          tls.HeartbeatMessageType.heartbeat_request,
          payload,
          payloadLength
        )
      }));
      return tls.flush(c);
    };
    c.close = function(clearFail) {
      if (!c.fail && c.sessionCache && c.session) {
        var session = {
          id: c.session.id,
          version: c.session.version,
          sp: c.session.sp
        };
        session.sp.keys = null;
        c.sessionCache.setSession(session.id, session);
      }
      if (c.open) {
        c.open = false;
        c.input.clear();
        if (c.isConnected || c.handshaking) {
          c.isConnected = c.handshaking = false;
          tls.queue(c, tls.createAlert(c, {
            level: tls.Alert.Level.warning,
            description: tls.Alert.Description.close_notify
          }));
          tls.flush(c);
        }
        c.closed(c);
      }
      c.reset(clearFail);
    };
    return c;
  };
  tls_1 = forge2.tls = forge2.tls || {};
  for (var key in tls) {
    if (typeof tls[key] !== "function") {
      forge2.tls[key] = tls[key];
    }
  }
  forge2.tls.prf_tls1 = prf_TLS1;
  forge2.tls.hmac_sha1 = hmac_sha1;
  forge2.tls.createSessionCache = tls.createSessionCache;
  forge2.tls.createConnection = tls.createConnection;
  return tls_1;
}
var hasRequiredAesCipherSuites;
function requireAesCipherSuites() {
  if (hasRequiredAesCipherSuites) return aesCipherSuites.exports;
  hasRequiredAesCipherSuites = 1;
  var forge2 = requireForge();
  requireAes();
  requireTls();
  var tls = aesCipherSuites.exports = forge2.tls;
  tls.CipherSuites["TLS_RSA_WITH_AES_128_CBC_SHA"] = {
    id: [0, 47],
    name: "TLS_RSA_WITH_AES_128_CBC_SHA",
    initSecurityParameters: function(sp) {
      sp.bulk_cipher_algorithm = tls.BulkCipherAlgorithm.aes;
      sp.cipher_type = tls.CipherType.block;
      sp.enc_key_length = 16;
      sp.block_length = 16;
      sp.fixed_iv_length = 16;
      sp.record_iv_length = 16;
      sp.mac_algorithm = tls.MACAlgorithm.hmac_sha1;
      sp.mac_length = 20;
      sp.mac_key_length = 20;
    },
    initConnectionState
  };
  tls.CipherSuites["TLS_RSA_WITH_AES_256_CBC_SHA"] = {
    id: [0, 53],
    name: "TLS_RSA_WITH_AES_256_CBC_SHA",
    initSecurityParameters: function(sp) {
      sp.bulk_cipher_algorithm = tls.BulkCipherAlgorithm.aes;
      sp.cipher_type = tls.CipherType.block;
      sp.enc_key_length = 32;
      sp.block_length = 16;
      sp.fixed_iv_length = 16;
      sp.record_iv_length = 16;
      sp.mac_algorithm = tls.MACAlgorithm.hmac_sha1;
      sp.mac_length = 20;
      sp.mac_key_length = 20;
    },
    initConnectionState
  };
  function initConnectionState(state, c, sp) {
    var client = c.entity === forge2.tls.ConnectionEnd.client;
    state.read.cipherState = {
      init: false,
      cipher: forge2.cipher.createDecipher("AES-CBC", client ? sp.keys.server_write_key : sp.keys.client_write_key),
      iv: client ? sp.keys.server_write_IV : sp.keys.client_write_IV
    };
    state.write.cipherState = {
      init: false,
      cipher: forge2.cipher.createCipher("AES-CBC", client ? sp.keys.client_write_key : sp.keys.server_write_key),
      iv: client ? sp.keys.client_write_IV : sp.keys.server_write_IV
    };
    state.read.cipherFunction = decrypt_aes_cbc_sha1;
    state.write.cipherFunction = encrypt_aes_cbc_sha1;
    state.read.macLength = state.write.macLength = sp.mac_length;
    state.read.macFunction = state.write.macFunction = tls.hmac_sha1;
  }
  function encrypt_aes_cbc_sha1(record, s) {
    var rval = false;
    var mac = s.macFunction(s.macKey, s.sequenceNumber, record);
    record.fragment.putBytes(mac);
    s.updateSequenceNumber();
    var iv;
    if (record.version.minor === tls.Versions.TLS_1_0.minor) {
      iv = s.cipherState.init ? null : s.cipherState.iv;
    } else {
      iv = forge2.random.getBytesSync(16);
    }
    s.cipherState.init = true;
    var cipher2 = s.cipherState.cipher;
    cipher2.start({ iv });
    if (record.version.minor >= tls.Versions.TLS_1_1.minor) {
      cipher2.output.putBytes(iv);
    }
    cipher2.update(record.fragment);
    if (cipher2.finish(encrypt_aes_cbc_sha1_padding)) {
      record.fragment = cipher2.output;
      record.length = record.fragment.length();
      rval = true;
    }
    return rval;
  }
  function encrypt_aes_cbc_sha1_padding(blockSize, input, decrypt) {
    if (!decrypt) {
      var padding = blockSize - input.length() % blockSize;
      input.fillWithByte(padding - 1, padding);
    }
    return true;
  }
  function decrypt_aes_cbc_sha1_padding(blockSize, output, decrypt) {
    var rval = true;
    if (decrypt) {
      var len = output.length();
      var paddingLength = output.last();
      for (var i = len - 1 - paddingLength; i < len - 1; ++i) {
        rval = rval && output.at(i) == paddingLength;
      }
      if (rval) {
        output.truncate(paddingLength + 1);
      }
    }
    return rval;
  }
  function decrypt_aes_cbc_sha1(record, s) {
    var rval = false;
    var iv;
    if (record.version.minor === tls.Versions.TLS_1_0.minor) {
      iv = s.cipherState.init ? null : s.cipherState.iv;
    } else {
      iv = record.fragment.getBytes(16);
    }
    s.cipherState.init = true;
    var cipher2 = s.cipherState.cipher;
    cipher2.start({ iv });
    cipher2.update(record.fragment);
    rval = cipher2.finish(decrypt_aes_cbc_sha1_padding);
    var macLen = s.macLength;
    var mac = forge2.random.getBytesSync(macLen);
    var len = cipher2.output.length();
    if (len >= macLen) {
      record.fragment = cipher2.output.getBytes(len - macLen);
      mac = cipher2.output.getBytes(macLen);
    } else {
      record.fragment = cipher2.output.getBytes();
    }
    record.fragment = forge2.util.createBuffer(record.fragment);
    record.length = record.fragment.length();
    var mac2 = s.macFunction(s.macKey, s.sequenceNumber, record);
    s.updateSequenceNumber();
    rval = compareMacs(s.macKey, mac, mac2) && rval;
    return rval;
  }
  function compareMacs(key, mac1, mac2) {
    var hmac2 = forge2.hmac.create();
    hmac2.start("SHA1", key);
    hmac2.update(mac1);
    mac1 = hmac2.digest().getBytes();
    hmac2.start(null, null);
    hmac2.update(mac2);
    mac2 = hmac2.digest().getBytes();
    return mac1 === mac2;
  }
  return aesCipherSuites.exports;
}
var sha512 = { exports: {} };
var hasRequiredSha512;
function requireSha512() {
  if (hasRequiredSha512) return sha512.exports;
  hasRequiredSha512 = 1;
  var forge2 = requireForge();
  requireMd();
  requireUtil();
  var sha512$1 = sha512.exports = forge2.sha512 = forge2.sha512 || {};
  forge2.md.sha512 = forge2.md.algorithms.sha512 = sha512$1;
  var sha384 = forge2.sha384 = forge2.sha512.sha384 = forge2.sha512.sha384 || {};
  sha384.create = function() {
    return sha512$1.create("SHA-384");
  };
  forge2.md.sha384 = forge2.md.algorithms.sha384 = sha384;
  forge2.sha512.sha256 = forge2.sha512.sha256 || {
    create: function() {
      return sha512$1.create("SHA-512/256");
    }
  };
  forge2.md["sha512/256"] = forge2.md.algorithms["sha512/256"] = forge2.sha512.sha256;
  forge2.sha512.sha224 = forge2.sha512.sha224 || {
    create: function() {
      return sha512$1.create("SHA-512/224");
    }
  };
  forge2.md["sha512/224"] = forge2.md.algorithms["sha512/224"] = forge2.sha512.sha224;
  sha512$1.create = function(algorithm) {
    if (!_initialized) {
      _init();
    }
    if (typeof algorithm === "undefined") {
      algorithm = "SHA-512";
    }
    if (!(algorithm in _states)) {
      throw new Error("Invalid SHA-512 algorithm: " + algorithm);
    }
    var _state = _states[algorithm];
    var _h = null;
    var _input = forge2.util.createBuffer();
    var _w = new Array(80);
    for (var wi = 0; wi < 80; ++wi) {
      _w[wi] = new Array(2);
    }
    var digestLength = 64;
    switch (algorithm) {
      case "SHA-384":
        digestLength = 48;
        break;
      case "SHA-512/256":
        digestLength = 32;
        break;
      case "SHA-512/224":
        digestLength = 28;
        break;
    }
    var md2 = {
      // SHA-512 => sha512
      algorithm: algorithm.replace("-", "").toLowerCase(),
      blockLength: 128,
      digestLength,
      // 56-bit length of message so far (does not including padding)
      messageLength: 0,
      // true message length
      fullMessageLength: null,
      // size of message length in bytes
      messageLengthSize: 16
    };
    md2.start = function() {
      md2.messageLength = 0;
      md2.fullMessageLength = md2.messageLength128 = [];
      var int32s = md2.messageLengthSize / 4;
      for (var i = 0; i < int32s; ++i) {
        md2.fullMessageLength.push(0);
      }
      _input = forge2.util.createBuffer();
      _h = new Array(_state.length);
      for (var i = 0; i < _state.length; ++i) {
        _h[i] = _state[i].slice(0);
      }
      return md2;
    };
    md2.start();
    md2.update = function(msg, encoding) {
      if (encoding === "utf8") {
        msg = forge2.util.encodeUtf8(msg);
      }
      var len = msg.length;
      md2.messageLength += len;
      len = [len / 4294967296 >>> 0, len >>> 0];
      for (var i = md2.fullMessageLength.length - 1; i >= 0; --i) {
        md2.fullMessageLength[i] += len[1];
        len[1] = len[0] + (md2.fullMessageLength[i] / 4294967296 >>> 0);
        md2.fullMessageLength[i] = md2.fullMessageLength[i] >>> 0;
        len[0] = len[1] / 4294967296 >>> 0;
      }
      _input.putBytes(msg);
      _update(_h, _w, _input);
      if (_input.read > 2048 || _input.length() === 0) {
        _input.compact();
      }
      return md2;
    };
    md2.digest = function() {
      var finalBlock = forge2.util.createBuffer();
      finalBlock.putBytes(_input.bytes());
      var remaining = md2.fullMessageLength[md2.fullMessageLength.length - 1] + md2.messageLengthSize;
      var overflow = remaining & md2.blockLength - 1;
      finalBlock.putBytes(_padding.substr(0, md2.blockLength - overflow));
      var next, carry;
      var bits = md2.fullMessageLength[0] * 8;
      for (var i = 0; i < md2.fullMessageLength.length - 1; ++i) {
        next = md2.fullMessageLength[i + 1] * 8;
        carry = next / 4294967296 >>> 0;
        bits += carry;
        finalBlock.putInt32(bits >>> 0);
        bits = next >>> 0;
      }
      finalBlock.putInt32(bits);
      var h = new Array(_h.length);
      for (var i = 0; i < _h.length; ++i) {
        h[i] = _h[i].slice(0);
      }
      _update(h, _w, finalBlock);
      var rval = forge2.util.createBuffer();
      var hlen;
      if (algorithm === "SHA-512") {
        hlen = h.length;
      } else if (algorithm === "SHA-384") {
        hlen = h.length - 2;
      } else {
        hlen = h.length - 4;
      }
      for (var i = 0; i < hlen; ++i) {
        rval.putInt32(h[i][0]);
        if (i !== hlen - 1 || algorithm !== "SHA-512/224") {
          rval.putInt32(h[i][1]);
        }
      }
      return rval;
    };
    return md2;
  };
  var _padding = null;
  var _initialized = false;
  var _k = null;
  var _states = null;
  function _init() {
    _padding = String.fromCharCode(128);
    _padding += forge2.util.fillString(String.fromCharCode(0), 128);
    _k = [
      [1116352408, 3609767458],
      [1899447441, 602891725],
      [3049323471, 3964484399],
      [3921009573, 2173295548],
      [961987163, 4081628472],
      [1508970993, 3053834265],
      [2453635748, 2937671579],
      [2870763221, 3664609560],
      [3624381080, 2734883394],
      [310598401, 1164996542],
      [607225278, 1323610764],
      [1426881987, 3590304994],
      [1925078388, 4068182383],
      [2162078206, 991336113],
      [2614888103, 633803317],
      [3248222580, 3479774868],
      [3835390401, 2666613458],
      [4022224774, 944711139],
      [264347078, 2341262773],
      [604807628, 2007800933],
      [770255983, 1495990901],
      [1249150122, 1856431235],
      [1555081692, 3175218132],
      [1996064986, 2198950837],
      [2554220882, 3999719339],
      [2821834349, 766784016],
      [2952996808, 2566594879],
      [3210313671, 3203337956],
      [3336571891, 1034457026],
      [3584528711, 2466948901],
      [113926993, 3758326383],
      [338241895, 168717936],
      [666307205, 1188179964],
      [773529912, 1546045734],
      [1294757372, 1522805485],
      [1396182291, 2643833823],
      [1695183700, 2343527390],
      [1986661051, 1014477480],
      [2177026350, 1206759142],
      [2456956037, 344077627],
      [2730485921, 1290863460],
      [2820302411, 3158454273],
      [3259730800, 3505952657],
      [3345764771, 106217008],
      [3516065817, 3606008344],
      [3600352804, 1432725776],
      [4094571909, 1467031594],
      [275423344, 851169720],
      [430227734, 3100823752],
      [506948616, 1363258195],
      [659060556, 3750685593],
      [883997877, 3785050280],
      [958139571, 3318307427],
      [1322822218, 3812723403],
      [1537002063, 2003034995],
      [1747873779, 3602036899],
      [1955562222, 1575990012],
      [2024104815, 1125592928],
      [2227730452, 2716904306],
      [2361852424, 442776044],
      [2428436474, 593698344],
      [2756734187, 3733110249],
      [3204031479, 2999351573],
      [3329325298, 3815920427],
      [3391569614, 3928383900],
      [3515267271, 566280711],
      [3940187606, 3454069534],
      [4118630271, 4000239992],
      [116418474, 1914138554],
      [174292421, 2731055270],
      [289380356, 3203993006],
      [460393269, 320620315],
      [685471733, 587496836],
      [852142971, 1086792851],
      [1017036298, 365543100],
      [1126000580, 2618297676],
      [1288033470, 3409855158],
      [1501505948, 4234509866],
      [1607167915, 987167468],
      [1816402316, 1246189591]
    ];
    _states = {};
    _states["SHA-512"] = [
      [1779033703, 4089235720],
      [3144134277, 2227873595],
      [1013904242, 4271175723],
      [2773480762, 1595750129],
      [1359893119, 2917565137],
      [2600822924, 725511199],
      [528734635, 4215389547],
      [1541459225, 327033209]
    ];
    _states["SHA-384"] = [
      [3418070365, 3238371032],
      [1654270250, 914150663],
      [2438529370, 812702999],
      [355462360, 4144912697],
      [1731405415, 4290775857],
      [2394180231, 1750603025],
      [3675008525, 1694076839],
      [1203062813, 3204075428]
    ];
    _states["SHA-512/256"] = [
      [573645204, 4230739756],
      [2673172387, 3360449730],
      [596883563, 1867755857],
      [2520282905, 1497426621],
      [2519219938, 2827943907],
      [3193839141, 1401305490],
      [721525244, 746961066],
      [246885852, 2177182882]
    ];
    _states["SHA-512/224"] = [
      [2352822216, 424955298],
      [1944164710, 2312950998],
      [502970286, 855612546],
      [1738396948, 1479516111],
      [258812777, 2077511080],
      [2011393907, 79989058],
      [1067287976, 1780299464],
      [286451373, 2446758561]
    ];
    _initialized = true;
  }
  function _update(s, w, bytes) {
    var t1_hi, t1_lo;
    var t2_hi, t2_lo;
    var s0_hi, s0_lo;
    var s1_hi, s1_lo;
    var ch_hi, ch_lo;
    var maj_hi, maj_lo;
    var a_hi, a_lo;
    var b_hi, b_lo;
    var c_hi, c_lo;
    var d_hi, d_lo;
    var e_hi, e_lo;
    var f_hi, f_lo;
    var g_hi, g_lo;
    var h_hi, h_lo;
    var i, hi, lo, w2, w7, w15, w16;
    var len = bytes.length();
    while (len >= 128) {
      for (i = 0; i < 16; ++i) {
        w[i][0] = bytes.getInt32() >>> 0;
        w[i][1] = bytes.getInt32() >>> 0;
      }
      for (; i < 80; ++i) {
        w2 = w[i - 2];
        hi = w2[0];
        lo = w2[1];
        t1_hi = ((hi >>> 19 | lo << 13) ^ // ROTR 19
        (lo >>> 29 | hi << 3) ^ // ROTR 61/(swap + ROTR 29)
        hi >>> 6) >>> 0;
        t1_lo = ((hi << 13 | lo >>> 19) ^ // ROTR 19
        (lo << 3 | hi >>> 29) ^ // ROTR 61/(swap + ROTR 29)
        (hi << 26 | lo >>> 6)) >>> 0;
        w15 = w[i - 15];
        hi = w15[0];
        lo = w15[1];
        t2_hi = ((hi >>> 1 | lo << 31) ^ // ROTR 1
        (hi >>> 8 | lo << 24) ^ // ROTR 8
        hi >>> 7) >>> 0;
        t2_lo = ((hi << 31 | lo >>> 1) ^ // ROTR 1
        (hi << 24 | lo >>> 8) ^ // ROTR 8
        (hi << 25 | lo >>> 7)) >>> 0;
        w7 = w[i - 7];
        w16 = w[i - 16];
        lo = t1_lo + w7[1] + t2_lo + w16[1];
        w[i][0] = t1_hi + w7[0] + t2_hi + w16[0] + (lo / 4294967296 >>> 0) >>> 0;
        w[i][1] = lo >>> 0;
      }
      a_hi = s[0][0];
      a_lo = s[0][1];
      b_hi = s[1][0];
      b_lo = s[1][1];
      c_hi = s[2][0];
      c_lo = s[2][1];
      d_hi = s[3][0];
      d_lo = s[3][1];
      e_hi = s[4][0];
      e_lo = s[4][1];
      f_hi = s[5][0];
      f_lo = s[5][1];
      g_hi = s[6][0];
      g_lo = s[6][1];
      h_hi = s[7][0];
      h_lo = s[7][1];
      for (i = 0; i < 80; ++i) {
        s1_hi = ((e_hi >>> 14 | e_lo << 18) ^ // ROTR 14
        (e_hi >>> 18 | e_lo << 14) ^ // ROTR 18
        (e_lo >>> 9 | e_hi << 23)) >>> 0;
        s1_lo = ((e_hi << 18 | e_lo >>> 14) ^ // ROTR 14
        (e_hi << 14 | e_lo >>> 18) ^ // ROTR 18
        (e_lo << 23 | e_hi >>> 9)) >>> 0;
        ch_hi = (g_hi ^ e_hi & (f_hi ^ g_hi)) >>> 0;
        ch_lo = (g_lo ^ e_lo & (f_lo ^ g_lo)) >>> 0;
        s0_hi = ((a_hi >>> 28 | a_lo << 4) ^ // ROTR 28
        (a_lo >>> 2 | a_hi << 30) ^ // ROTR 34/(swap + ROTR 2)
        (a_lo >>> 7 | a_hi << 25)) >>> 0;
        s0_lo = ((a_hi << 4 | a_lo >>> 28) ^ // ROTR 28
        (a_lo << 30 | a_hi >>> 2) ^ // ROTR 34/(swap + ROTR 2)
        (a_lo << 25 | a_hi >>> 7)) >>> 0;
        maj_hi = (a_hi & b_hi | c_hi & (a_hi ^ b_hi)) >>> 0;
        maj_lo = (a_lo & b_lo | c_lo & (a_lo ^ b_lo)) >>> 0;
        lo = h_lo + s1_lo + ch_lo + _k[i][1] + w[i][1];
        t1_hi = h_hi + s1_hi + ch_hi + _k[i][0] + w[i][0] + (lo / 4294967296 >>> 0) >>> 0;
        t1_lo = lo >>> 0;
        lo = s0_lo + maj_lo;
        t2_hi = s0_hi + maj_hi + (lo / 4294967296 >>> 0) >>> 0;
        t2_lo = lo >>> 0;
        h_hi = g_hi;
        h_lo = g_lo;
        g_hi = f_hi;
        g_lo = f_lo;
        f_hi = e_hi;
        f_lo = e_lo;
        lo = d_lo + t1_lo;
        e_hi = d_hi + t1_hi + (lo / 4294967296 >>> 0) >>> 0;
        e_lo = lo >>> 0;
        d_hi = c_hi;
        d_lo = c_lo;
        c_hi = b_hi;
        c_lo = b_lo;
        b_hi = a_hi;
        b_lo = a_lo;
        lo = t1_lo + t2_lo;
        a_hi = t1_hi + t2_hi + (lo / 4294967296 >>> 0) >>> 0;
        a_lo = lo >>> 0;
      }
      lo = s[0][1] + a_lo;
      s[0][0] = s[0][0] + a_hi + (lo / 4294967296 >>> 0) >>> 0;
      s[0][1] = lo >>> 0;
      lo = s[1][1] + b_lo;
      s[1][0] = s[1][0] + b_hi + (lo / 4294967296 >>> 0) >>> 0;
      s[1][1] = lo >>> 0;
      lo = s[2][1] + c_lo;
      s[2][0] = s[2][0] + c_hi + (lo / 4294967296 >>> 0) >>> 0;
      s[2][1] = lo >>> 0;
      lo = s[3][1] + d_lo;
      s[3][0] = s[3][0] + d_hi + (lo / 4294967296 >>> 0) >>> 0;
      s[3][1] = lo >>> 0;
      lo = s[4][1] + e_lo;
      s[4][0] = s[4][0] + e_hi + (lo / 4294967296 >>> 0) >>> 0;
      s[4][1] = lo >>> 0;
      lo = s[5][1] + f_lo;
      s[5][0] = s[5][0] + f_hi + (lo / 4294967296 >>> 0) >>> 0;
      s[5][1] = lo >>> 0;
      lo = s[6][1] + g_lo;
      s[6][0] = s[6][0] + g_hi + (lo / 4294967296 >>> 0) >>> 0;
      s[6][1] = lo >>> 0;
      lo = s[7][1] + h_lo;
      s[7][0] = s[7][0] + h_hi + (lo / 4294967296 >>> 0) >>> 0;
      s[7][1] = lo >>> 0;
      len -= 128;
    }
  }
  return sha512.exports;
}
var asn1Validator = {};
var hasRequiredAsn1Validator;
function requireAsn1Validator() {
  if (hasRequiredAsn1Validator) return asn1Validator;
  hasRequiredAsn1Validator = 1;
  var forge2 = requireForge();
  requireAsn1();
  var asn12 = forge2.asn1;
  asn1Validator.privateKeyValidator = {
    // PrivateKeyInfo
    name: "PrivateKeyInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    value: [{
      // Version (INTEGER)
      name: "PrivateKeyInfo.version",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.INTEGER,
      constructed: false,
      capture: "privateKeyVersion"
    }, {
      // privateKeyAlgorithm
      name: "PrivateKeyInfo.privateKeyAlgorithm",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.SEQUENCE,
      constructed: true,
      value: [{
        name: "AlgorithmIdentifier.algorithm",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.OID,
        constructed: false,
        capture: "privateKeyOid"
      }]
    }, {
      // PrivateKey
      name: "PrivateKeyInfo",
      tagClass: asn12.Class.UNIVERSAL,
      type: asn12.Type.OCTETSTRING,
      constructed: false,
      capture: "privateKey"
    }]
  };
  asn1Validator.publicKeyValidator = {
    name: "SubjectPublicKeyInfo",
    tagClass: asn12.Class.UNIVERSAL,
    type: asn12.Type.SEQUENCE,
    constructed: true,
    captureAsn1: "subjectPublicKeyInfo",
    value: [
      {
        name: "SubjectPublicKeyInfo.AlgorithmIdentifier",
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.SEQUENCE,
        constructed: true,
        value: [{
          name: "AlgorithmIdentifier.algorithm",
          tagClass: asn12.Class.UNIVERSAL,
          type: asn12.Type.OID,
          constructed: false,
          capture: "publicKeyOid"
        }]
      },
      // capture group for ed25519PublicKey
      {
        tagClass: asn12.Class.UNIVERSAL,
        type: asn12.Type.BITSTRING,
        constructed: false,
        composed: true,
        captureBitStringValue: "ed25519PublicKey"
      }
      // FIXME: this is capture group for rsaPublicKey, use it in this API or
      // discard?
      /* {
        // subjectPublicKey
        name: 'SubjectPublicKeyInfo.subjectPublicKey',
        tagClass: asn1.Class.UNIVERSAL,
        type: asn1.Type.BITSTRING,
        constructed: false,
        value: [{
          // RSAPublicKey
          name: 'SubjectPublicKeyInfo.subjectPublicKey.RSAPublicKey',
          tagClass: asn1.Class.UNIVERSAL,
          type: asn1.Type.SEQUENCE,
          constructed: true,
          optional: true,
          captureAsn1: 'rsaPublicKey'
        }]
      } */
    ]
  };
  return asn1Validator;
}
var ed25519_1;
var hasRequiredEd25519;
function requireEd25519() {
  if (hasRequiredEd25519) return ed25519_1;
  hasRequiredEd25519 = 1;
  var forge2 = requireForge();
  requireJsbn();
  requireRandom();
  requireSha512();
  requireUtil();
  var asn1Validator2 = requireAsn1Validator();
  var publicKeyValidator = asn1Validator2.publicKeyValidator;
  var privateKeyValidator = asn1Validator2.privateKeyValidator;
  if (typeof BigInteger === "undefined") {
    var BigInteger = forge2.jsbn.BigInteger;
  }
  var ByteBuffer = forge2.util.ByteBuffer;
  var NativeBuffer = typeof Buffer === "undefined" ? Uint8Array : Buffer;
  forge2.pki = forge2.pki || {};
  ed25519_1 = forge2.pki.ed25519 = forge2.ed25519 = forge2.ed25519 || {};
  var ed25519 = forge2.ed25519;
  ed25519.constants = {};
  ed25519.constants.PUBLIC_KEY_BYTE_LENGTH = 32;
  ed25519.constants.PRIVATE_KEY_BYTE_LENGTH = 64;
  ed25519.constants.SEED_BYTE_LENGTH = 32;
  ed25519.constants.SIGN_BYTE_LENGTH = 64;
  ed25519.constants.HASH_BYTE_LENGTH = 64;
  ed25519.generateKeyPair = function(options) {
    options = options || {};
    var seed = options.seed;
    if (seed === void 0) {
      seed = forge2.random.getBytesSync(ed25519.constants.SEED_BYTE_LENGTH);
    } else if (typeof seed === "string") {
      if (seed.length !== ed25519.constants.SEED_BYTE_LENGTH) {
        throw new TypeError(
          '"seed" must be ' + ed25519.constants.SEED_BYTE_LENGTH + " bytes in length."
        );
      }
    } else if (!(seed instanceof Uint8Array)) {
      throw new TypeError(
        '"seed" must be a node.js Buffer, Uint8Array, or a binary string.'
      );
    }
    seed = messageToNativeBuffer({ message: seed, encoding: "binary" });
    var pk = new NativeBuffer(ed25519.constants.PUBLIC_KEY_BYTE_LENGTH);
    var sk = new NativeBuffer(ed25519.constants.PRIVATE_KEY_BYTE_LENGTH);
    for (var i = 0; i < 32; ++i) {
      sk[i] = seed[i];
    }
    crypto_sign_keypair(pk, sk);
    return { publicKey: pk, privateKey: sk };
  };
  ed25519.privateKeyFromAsn1 = function(obj) {
    var capture = {};
    var errors = [];
    var valid = forge2.asn1.validate(obj, privateKeyValidator, capture, errors);
    if (!valid) {
      var error = new Error("Invalid Key.");
      error.errors = errors;
      throw error;
    }
    var oid = forge2.asn1.derToOid(capture.privateKeyOid);
    var ed25519Oid = forge2.oids.EdDSA25519;
    if (oid !== ed25519Oid) {
      throw new Error('Invalid OID "' + oid + '"; OID must be "' + ed25519Oid + '".');
    }
    var privateKey = capture.privateKey;
    var privateKeyBytes = messageToNativeBuffer({
      message: forge2.asn1.fromDer(privateKey).value,
      encoding: "binary"
    });
    return { privateKeyBytes };
  };
  ed25519.publicKeyFromAsn1 = function(obj) {
    var capture = {};
    var errors = [];
    var valid = forge2.asn1.validate(obj, publicKeyValidator, capture, errors);
    if (!valid) {
      var error = new Error("Invalid Key.");
      error.errors = errors;
      throw error;
    }
    var oid = forge2.asn1.derToOid(capture.publicKeyOid);
    var ed25519Oid = forge2.oids.EdDSA25519;
    if (oid !== ed25519Oid) {
      throw new Error('Invalid OID "' + oid + '"; OID must be "' + ed25519Oid + '".');
    }
    var publicKeyBytes = capture.ed25519PublicKey;
    if (publicKeyBytes.length !== ed25519.constants.PUBLIC_KEY_BYTE_LENGTH) {
      throw new Error("Key length is invalid.");
    }
    return messageToNativeBuffer({
      message: publicKeyBytes,
      encoding: "binary"
    });
  };
  ed25519.publicKeyFromPrivateKey = function(options) {
    options = options || {};
    var privateKey = messageToNativeBuffer({
      message: options.privateKey,
      encoding: "binary"
    });
    if (privateKey.length !== ed25519.constants.PRIVATE_KEY_BYTE_LENGTH) {
      throw new TypeError(
        '"options.privateKey" must have a byte length of ' + ed25519.constants.PRIVATE_KEY_BYTE_LENGTH
      );
    }
    var pk = new NativeBuffer(ed25519.constants.PUBLIC_KEY_BYTE_LENGTH);
    for (var i = 0; i < pk.length; ++i) {
      pk[i] = privateKey[32 + i];
    }
    return pk;
  };
  ed25519.sign = function(options) {
    options = options || {};
    var msg = messageToNativeBuffer(options);
    var privateKey = messageToNativeBuffer({
      message: options.privateKey,
      encoding: "binary"
    });
    if (privateKey.length === ed25519.constants.SEED_BYTE_LENGTH) {
      var keyPair = ed25519.generateKeyPair({ seed: privateKey });
      privateKey = keyPair.privateKey;
    } else if (privateKey.length !== ed25519.constants.PRIVATE_KEY_BYTE_LENGTH) {
      throw new TypeError(
        '"options.privateKey" must have a byte length of ' + ed25519.constants.SEED_BYTE_LENGTH + " or " + ed25519.constants.PRIVATE_KEY_BYTE_LENGTH
      );
    }
    var signedMsg = new NativeBuffer(
      ed25519.constants.SIGN_BYTE_LENGTH + msg.length
    );
    crypto_sign(signedMsg, msg, msg.length, privateKey);
    var sig = new NativeBuffer(ed25519.constants.SIGN_BYTE_LENGTH);
    for (var i = 0; i < sig.length; ++i) {
      sig[i] = signedMsg[i];
    }
    return sig;
  };
  ed25519.verify = function(options) {
    options = options || {};
    var msg = messageToNativeBuffer(options);
    if (options.signature === void 0) {
      throw new TypeError(
        '"options.signature" must be a node.js Buffer, a Uint8Array, a forge ByteBuffer, or a binary string.'
      );
    }
    var sig = messageToNativeBuffer({
      message: options.signature,
      encoding: "binary"
    });
    if (sig.length !== ed25519.constants.SIGN_BYTE_LENGTH) {
      throw new TypeError(
        '"options.signature" must have a byte length of ' + ed25519.constants.SIGN_BYTE_LENGTH
      );
    }
    var publicKey = messageToNativeBuffer({
      message: options.publicKey,
      encoding: "binary"
    });
    if (publicKey.length !== ed25519.constants.PUBLIC_KEY_BYTE_LENGTH) {
      throw new TypeError(
        '"options.publicKey" must have a byte length of ' + ed25519.constants.PUBLIC_KEY_BYTE_LENGTH
      );
    }
    var sm = new NativeBuffer(ed25519.constants.SIGN_BYTE_LENGTH + msg.length);
    var m = new NativeBuffer(ed25519.constants.SIGN_BYTE_LENGTH + msg.length);
    var i;
    for (i = 0; i < ed25519.constants.SIGN_BYTE_LENGTH; ++i) {
      sm[i] = sig[i];
    }
    for (i = 0; i < msg.length; ++i) {
      sm[i + ed25519.constants.SIGN_BYTE_LENGTH] = msg[i];
    }
    return crypto_sign_open(m, sm, sm.length, publicKey) >= 0;
  };
  function messageToNativeBuffer(options) {
    var message = options.message;
    if (message instanceof Uint8Array || message instanceof NativeBuffer) {
      return message;
    }
    var encoding = options.encoding;
    if (message === void 0) {
      if (options.md) {
        message = options.md.digest().getBytes();
        encoding = "binary";
      } else {
        throw new TypeError('"options.message" or "options.md" not specified.');
      }
    }
    if (typeof message === "string" && !encoding) {
      throw new TypeError('"options.encoding" must be "binary" or "utf8".');
    }
    if (typeof message === "string") {
      if (typeof Buffer !== "undefined") {
        return Buffer.from(message, encoding);
      }
      message = new ByteBuffer(message, encoding);
    } else if (!(message instanceof ByteBuffer)) {
      throw new TypeError(
        '"options.message" must be a node.js Buffer, a Uint8Array, a forge ByteBuffer, or a string with "options.encoding" specifying its encoding.'
      );
    }
    var buffer = new NativeBuffer(message.length());
    for (var i = 0; i < buffer.length; ++i) {
      buffer[i] = message.at(i);
    }
    return buffer;
  }
  var gf0 = gf();
  var gf1 = gf([1]);
  var D = gf([
    30883,
    4953,
    19914,
    30187,
    55467,
    16705,
    2637,
    112,
    59544,
    30585,
    16505,
    36039,
    65139,
    11119,
    27886,
    20995
  ]);
  var D2 = gf([
    61785,
    9906,
    39828,
    60374,
    45398,
    33411,
    5274,
    224,
    53552,
    61171,
    33010,
    6542,
    64743,
    22239,
    55772,
    9222
  ]);
  var X = gf([
    54554,
    36645,
    11616,
    51542,
    42930,
    38181,
    51040,
    26924,
    56412,
    64982,
    57905,
    49316,
    21502,
    52590,
    14035,
    8553
  ]);
  var Y = gf([
    26200,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214,
    26214
  ]);
  var L = new Float64Array([
    237,
    211,
    245,
    92,
    26,
    99,
    18,
    88,
    214,
    156,
    247,
    162,
    222,
    249,
    222,
    20,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    16
  ]);
  var I = gf([
    41136,
    18958,
    6951,
    50414,
    58488,
    44335,
    6150,
    12099,
    55207,
    15867,
    153,
    11085,
    57099,
    20417,
    9344,
    11139
  ]);
  function sha5122(msg, msgLen) {
    var md2 = forge2.md.sha512.create();
    var buffer = new ByteBuffer(msg);
    md2.update(buffer.getBytes(msgLen), "binary");
    var hash = md2.digest().getBytes();
    if (typeof Buffer !== "undefined") {
      return Buffer.from(hash, "binary");
    }
    var out = new NativeBuffer(ed25519.constants.HASH_BYTE_LENGTH);
    for (var i = 0; i < 64; ++i) {
      out[i] = hash.charCodeAt(i);
    }
    return out;
  }
  function crypto_sign_keypair(pk, sk) {
    var p = [gf(), gf(), gf(), gf()];
    var i;
    var d = sha5122(sk, 32);
    d[0] &= 248;
    d[31] &= 127;
    d[31] |= 64;
    scalarbase(p, d);
    pack(pk, p);
    for (i = 0; i < 32; ++i) {
      sk[i + 32] = pk[i];
    }
    return 0;
  }
  function crypto_sign(sm, m, n, sk) {
    var i, j, x = new Float64Array(64);
    var p = [gf(), gf(), gf(), gf()];
    var d = sha5122(sk, 32);
    d[0] &= 248;
    d[31] &= 127;
    d[31] |= 64;
    var smlen = n + 64;
    for (i = 0; i < n; ++i) {
      sm[64 + i] = m[i];
    }
    for (i = 0; i < 32; ++i) {
      sm[32 + i] = d[32 + i];
    }
    var r = sha5122(sm.subarray(32), n + 32);
    reduce(r);
    scalarbase(p, r);
    pack(sm, p);
    for (i = 32; i < 64; ++i) {
      sm[i] = sk[i];
    }
    var h = sha5122(sm, n + 64);
    reduce(h);
    for (i = 32; i < 64; ++i) {
      x[i] = 0;
    }
    for (i = 0; i < 32; ++i) {
      x[i] = r[i];
    }
    for (i = 0; i < 32; ++i) {
      for (j = 0; j < 32; j++) {
        x[i + j] += h[i] * d[j];
      }
    }
    modL(sm.subarray(32), x);
    return smlen;
  }
  function crypto_sign_open(m, sm, n, pk) {
    var i, mlen;
    var t = new NativeBuffer(32);
    var p = [gf(), gf(), gf(), gf()], q = [gf(), gf(), gf(), gf()];
    mlen = -1;
    if (n < 64) {
      return -1;
    }
    if (unpackneg(q, pk)) {
      return -1;
    }
    if (!_isCanonicalSignatureScalar(sm, 32)) {
      return -1;
    }
    for (i = 0; i < n; ++i) {
      m[i] = sm[i];
    }
    for (i = 0; i < 32; ++i) {
      m[i + 32] = pk[i];
    }
    var h = sha5122(m, n);
    reduce(h);
    scalarmult(p, q, h);
    scalarbase(q, sm.subarray(32));
    add(p, q);
    pack(t, p);
    n -= 64;
    if (crypto_verify_32(sm, 0, t, 0)) {
      for (i = 0; i < n; ++i) {
        m[i] = 0;
      }
      return -1;
    }
    for (i = 0; i < n; ++i) {
      m[i] = sm[i + 64];
    }
    mlen = n;
    return mlen;
  }
  function _isCanonicalSignatureScalar(bytes, offset) {
    var i;
    for (i = 31; i >= 0; --i) {
      if (bytes[offset + i] < L[i]) {
        return true;
      }
      if (bytes[offset + i] > L[i]) {
        return false;
      }
    }
    return false;
  }
  function modL(r, x) {
    var carry, i, j, k;
    for (i = 63; i >= 32; --i) {
      carry = 0;
      for (j = i - 32, k = i - 12; j < k; ++j) {
        x[j] += carry - 16 * x[i] * L[j - (i - 32)];
        carry = x[j] + 128 >> 8;
        x[j] -= carry * 256;
      }
      x[j] += carry;
      x[i] = 0;
    }
    carry = 0;
    for (j = 0; j < 32; ++j) {
      x[j] += carry - (x[31] >> 4) * L[j];
      carry = x[j] >> 8;
      x[j] &= 255;
    }
    for (j = 0; j < 32; ++j) {
      x[j] -= carry * L[j];
    }
    for (i = 0; i < 32; ++i) {
      x[i + 1] += x[i] >> 8;
      r[i] = x[i] & 255;
    }
  }
  function reduce(r) {
    var x = new Float64Array(64);
    for (var i = 0; i < 64; ++i) {
      x[i] = r[i];
      r[i] = 0;
    }
    modL(r, x);
  }
  function add(p, q) {
    var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf(), g = gf(), h = gf(), t = gf();
    Z(a, p[1], p[0]);
    Z(t, q[1], q[0]);
    M(a, a, t);
    A(b, p[0], p[1]);
    A(t, q[0], q[1]);
    M(b, b, t);
    M(c, p[3], q[3]);
    M(c, c, D2);
    M(d, p[2], q[2]);
    A(d, d, d);
    Z(e, b, a);
    Z(f, d, c);
    A(g, d, c);
    A(h, b, a);
    M(p[0], e, f);
    M(p[1], h, g);
    M(p[2], g, f);
    M(p[3], e, h);
  }
  function cswap(p, q, b) {
    for (var i = 0; i < 4; ++i) {
      sel25519(p[i], q[i], b);
    }
  }
  function pack(r, p) {
    var tx = gf(), ty = gf(), zi = gf();
    inv25519(zi, p[2]);
    M(tx, p[0], zi);
    M(ty, p[1], zi);
    pack25519(r, ty);
    r[31] ^= par25519(tx) << 7;
  }
  function pack25519(o, n) {
    var i, j, b;
    var m = gf(), t = gf();
    for (i = 0; i < 16; ++i) {
      t[i] = n[i];
    }
    car25519(t);
    car25519(t);
    car25519(t);
    for (j = 0; j < 2; ++j) {
      m[0] = t[0] - 65517;
      for (i = 1; i < 15; ++i) {
        m[i] = t[i] - 65535 - (m[i - 1] >> 16 & 1);
        m[i - 1] &= 65535;
      }
      m[15] = t[15] - 32767 - (m[14] >> 16 & 1);
      b = m[15] >> 16 & 1;
      m[14] &= 65535;
      sel25519(t, m, 1 - b);
    }
    for (i = 0; i < 16; i++) {
      o[2 * i] = t[i] & 255;
      o[2 * i + 1] = t[i] >> 8;
    }
  }
  function unpackneg(r, p) {
    var t = gf(), chk = gf(), num = gf(), den = gf(), den2 = gf(), den4 = gf(), den6 = gf();
    set25519(r[2], gf1);
    unpack25519(r[1], p);
    S(num, r[1]);
    M(den, num, D);
    Z(num, num, r[2]);
    A(den, r[2], den);
    S(den2, den);
    S(den4, den2);
    M(den6, den4, den2);
    M(t, den6, num);
    M(t, t, den);
    pow2523(t, t);
    M(t, t, num);
    M(t, t, den);
    M(t, t, den);
    M(r[0], t, den);
    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) {
      M(r[0], r[0], I);
    }
    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) {
      return -1;
    }
    if (par25519(r[0]) === p[31] >> 7) {
      Z(r[0], gf0, r[0]);
    }
    M(r[3], r[0], r[1]);
    return 0;
  }
  function unpack25519(o, n) {
    var i;
    for (i = 0; i < 16; ++i) {
      o[i] = n[2 * i] + (n[2 * i + 1] << 8);
    }
    o[15] &= 32767;
  }
  function pow2523(o, i) {
    var c = gf();
    var a;
    for (a = 0; a < 16; ++a) {
      c[a] = i[a];
    }
    for (a = 250; a >= 0; --a) {
      S(c, c);
      if (a !== 1) {
        M(c, c, i);
      }
    }
    for (a = 0; a < 16; ++a) {
      o[a] = c[a];
    }
  }
  function neq25519(a, b) {
    var c = new NativeBuffer(32);
    var d = new NativeBuffer(32);
    pack25519(c, a);
    pack25519(d, b);
    return crypto_verify_32(c, 0, d, 0);
  }
  function crypto_verify_32(x, xi, y, yi) {
    return vn(x, xi, y, yi, 32);
  }
  function vn(x, xi, y, yi, n) {
    var i, d = 0;
    for (i = 0; i < n; ++i) {
      d |= x[xi + i] ^ y[yi + i];
    }
    return (1 & d - 1 >>> 8) - 1;
  }
  function par25519(a) {
    var d = new NativeBuffer(32);
    pack25519(d, a);
    return d[0] & 1;
  }
  function scalarmult(p, q, s) {
    var b, i;
    set25519(p[0], gf0);
    set25519(p[1], gf1);
    set25519(p[2], gf1);
    set25519(p[3], gf0);
    for (i = 255; i >= 0; --i) {
      b = s[i / 8 | 0] >> (i & 7) & 1;
      cswap(p, q, b);
      add(q, p);
      add(p, p);
      cswap(p, q, b);
    }
  }
  function scalarbase(p, s) {
    var q = [gf(), gf(), gf(), gf()];
    set25519(q[0], X);
    set25519(q[1], Y);
    set25519(q[2], gf1);
    M(q[3], X, Y);
    scalarmult(p, q, s);
  }
  function set25519(r, a) {
    var i;
    for (i = 0; i < 16; i++) {
      r[i] = a[i] | 0;
    }
  }
  function inv25519(o, i) {
    var c = gf();
    var a;
    for (a = 0; a < 16; ++a) {
      c[a] = i[a];
    }
    for (a = 253; a >= 0; --a) {
      S(c, c);
      if (a !== 2 && a !== 4) {
        M(c, c, i);
      }
    }
    for (a = 0; a < 16; ++a) {
      o[a] = c[a];
    }
  }
  function car25519(o) {
    var i, v, c = 1;
    for (i = 0; i < 16; ++i) {
      v = o[i] + c + 65535;
      c = Math.floor(v / 65536);
      o[i] = v - c * 65536;
    }
    o[0] += c - 1 + 37 * (c - 1);
  }
  function sel25519(p, q, b) {
    var t, c = ~(b - 1);
    for (var i = 0; i < 16; ++i) {
      t = c & (p[i] ^ q[i]);
      p[i] ^= t;
      q[i] ^= t;
    }
  }
  function gf(init) {
    var i, r = new Float64Array(16);
    if (init) {
      for (i = 0; i < init.length; ++i) {
        r[i] = init[i];
      }
    }
    return r;
  }
  function A(o, a, b) {
    for (var i = 0; i < 16; ++i) {
      o[i] = a[i] + b[i];
    }
  }
  function Z(o, a, b) {
    for (var i = 0; i < 16; ++i) {
      o[i] = a[i] - b[i];
    }
  }
  function S(o, a) {
    M(o, a, a);
  }
  function M(o, a, b) {
    var v, c, t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0, t7 = 0, t8 = 0, t9 = 0, t10 = 0, t11 = 0, t12 = 0, t13 = 0, t14 = 0, t15 = 0, t16 = 0, t17 = 0, t18 = 0, t19 = 0, t20 = 0, t21 = 0, t22 = 0, t23 = 0, t24 = 0, t25 = 0, t26 = 0, t27 = 0, t28 = 0, t29 = 0, t30 = 0, b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11], b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];
    v = a[0];
    t0 += v * b0;
    t1 += v * b1;
    t2 += v * b2;
    t3 += v * b3;
    t4 += v * b4;
    t5 += v * b5;
    t6 += v * b6;
    t7 += v * b7;
    t8 += v * b8;
    t9 += v * b9;
    t10 += v * b10;
    t11 += v * b11;
    t12 += v * b12;
    t13 += v * b13;
    t14 += v * b14;
    t15 += v * b15;
    v = a[1];
    t1 += v * b0;
    t2 += v * b1;
    t3 += v * b2;
    t4 += v * b3;
    t5 += v * b4;
    t6 += v * b5;
    t7 += v * b6;
    t8 += v * b7;
    t9 += v * b8;
    t10 += v * b9;
    t11 += v * b10;
    t12 += v * b11;
    t13 += v * b12;
    t14 += v * b13;
    t15 += v * b14;
    t16 += v * b15;
    v = a[2];
    t2 += v * b0;
    t3 += v * b1;
    t4 += v * b2;
    t5 += v * b3;
    t6 += v * b4;
    t7 += v * b5;
    t8 += v * b6;
    t9 += v * b7;
    t10 += v * b8;
    t11 += v * b9;
    t12 += v * b10;
    t13 += v * b11;
    t14 += v * b12;
    t15 += v * b13;
    t16 += v * b14;
    t17 += v * b15;
    v = a[3];
    t3 += v * b0;
    t4 += v * b1;
    t5 += v * b2;
    t6 += v * b3;
    t7 += v * b4;
    t8 += v * b5;
    t9 += v * b6;
    t10 += v * b7;
    t11 += v * b8;
    t12 += v * b9;
    t13 += v * b10;
    t14 += v * b11;
    t15 += v * b12;
    t16 += v * b13;
    t17 += v * b14;
    t18 += v * b15;
    v = a[4];
    t4 += v * b0;
    t5 += v * b1;
    t6 += v * b2;
    t7 += v * b3;
    t8 += v * b4;
    t9 += v * b5;
    t10 += v * b6;
    t11 += v * b7;
    t12 += v * b8;
    t13 += v * b9;
    t14 += v * b10;
    t15 += v * b11;
    t16 += v * b12;
    t17 += v * b13;
    t18 += v * b14;
    t19 += v * b15;
    v = a[5];
    t5 += v * b0;
    t6 += v * b1;
    t7 += v * b2;
    t8 += v * b3;
    t9 += v * b4;
    t10 += v * b5;
    t11 += v * b6;
    t12 += v * b7;
    t13 += v * b8;
    t14 += v * b9;
    t15 += v * b10;
    t16 += v * b11;
    t17 += v * b12;
    t18 += v * b13;
    t19 += v * b14;
    t20 += v * b15;
    v = a[6];
    t6 += v * b0;
    t7 += v * b1;
    t8 += v * b2;
    t9 += v * b3;
    t10 += v * b4;
    t11 += v * b5;
    t12 += v * b6;
    t13 += v * b7;
    t14 += v * b8;
    t15 += v * b9;
    t16 += v * b10;
    t17 += v * b11;
    t18 += v * b12;
    t19 += v * b13;
    t20 += v * b14;
    t21 += v * b15;
    v = a[7];
    t7 += v * b0;
    t8 += v * b1;
    t9 += v * b2;
    t10 += v * b3;
    t11 += v * b4;
    t12 += v * b5;
    t13 += v * b6;
    t14 += v * b7;
    t15 += v * b8;
    t16 += v * b9;
    t17 += v * b10;
    t18 += v * b11;
    t19 += v * b12;
    t20 += v * b13;
    t21 += v * b14;
    t22 += v * b15;
    v = a[8];
    t8 += v * b0;
    t9 += v * b1;
    t10 += v * b2;
    t11 += v * b3;
    t12 += v * b4;
    t13 += v * b5;
    t14 += v * b6;
    t15 += v * b7;
    t16 += v * b8;
    t17 += v * b9;
    t18 += v * b10;
    t19 += v * b11;
    t20 += v * b12;
    t21 += v * b13;
    t22 += v * b14;
    t23 += v * b15;
    v = a[9];
    t9 += v * b0;
    t10 += v * b1;
    t11 += v * b2;
    t12 += v * b3;
    t13 += v * b4;
    t14 += v * b5;
    t15 += v * b6;
    t16 += v * b7;
    t17 += v * b8;
    t18 += v * b9;
    t19 += v * b10;
    t20 += v * b11;
    t21 += v * b12;
    t22 += v * b13;
    t23 += v * b14;
    t24 += v * b15;
    v = a[10];
    t10 += v * b0;
    t11 += v * b1;
    t12 += v * b2;
    t13 += v * b3;
    t14 += v * b4;
    t15 += v * b5;
    t16 += v * b6;
    t17 += v * b7;
    t18 += v * b8;
    t19 += v * b9;
    t20 += v * b10;
    t21 += v * b11;
    t22 += v * b12;
    t23 += v * b13;
    t24 += v * b14;
    t25 += v * b15;
    v = a[11];
    t11 += v * b0;
    t12 += v * b1;
    t13 += v * b2;
    t14 += v * b3;
    t15 += v * b4;
    t16 += v * b5;
    t17 += v * b6;
    t18 += v * b7;
    t19 += v * b8;
    t20 += v * b9;
    t21 += v * b10;
    t22 += v * b11;
    t23 += v * b12;
    t24 += v * b13;
    t25 += v * b14;
    t26 += v * b15;
    v = a[12];
    t12 += v * b0;
    t13 += v * b1;
    t14 += v * b2;
    t15 += v * b3;
    t16 += v * b4;
    t17 += v * b5;
    t18 += v * b6;
    t19 += v * b7;
    t20 += v * b8;
    t21 += v * b9;
    t22 += v * b10;
    t23 += v * b11;
    t24 += v * b12;
    t25 += v * b13;
    t26 += v * b14;
    t27 += v * b15;
    v = a[13];
    t13 += v * b0;
    t14 += v * b1;
    t15 += v * b2;
    t16 += v * b3;
    t17 += v * b4;
    t18 += v * b5;
    t19 += v * b6;
    t20 += v * b7;
    t21 += v * b8;
    t22 += v * b9;
    t23 += v * b10;
    t24 += v * b11;
    t25 += v * b12;
    t26 += v * b13;
    t27 += v * b14;
    t28 += v * b15;
    v = a[14];
    t14 += v * b0;
    t15 += v * b1;
    t16 += v * b2;
    t17 += v * b3;
    t18 += v * b4;
    t19 += v * b5;
    t20 += v * b6;
    t21 += v * b7;
    t22 += v * b8;
    t23 += v * b9;
    t24 += v * b10;
    t25 += v * b11;
    t26 += v * b12;
    t27 += v * b13;
    t28 += v * b14;
    t29 += v * b15;
    v = a[15];
    t15 += v * b0;
    t16 += v * b1;
    t17 += v * b2;
    t18 += v * b3;
    t19 += v * b4;
    t20 += v * b5;
    t21 += v * b6;
    t22 += v * b7;
    t23 += v * b8;
    t24 += v * b9;
    t25 += v * b10;
    t26 += v * b11;
    t27 += v * b12;
    t28 += v * b13;
    t29 += v * b14;
    t30 += v * b15;
    t0 += 38 * t16;
    t1 += 38 * t17;
    t2 += 38 * t18;
    t3 += 38 * t19;
    t4 += 38 * t20;
    t5 += 38 * t21;
    t6 += 38 * t22;
    t7 += 38 * t23;
    t8 += 38 * t24;
    t9 += 38 * t25;
    t10 += 38 * t26;
    t11 += 38 * t27;
    t12 += 38 * t28;
    t13 += 38 * t29;
    t14 += 38 * t30;
    c = 1;
    v = t0 + c + 65535;
    c = Math.floor(v / 65536);
    t0 = v - c * 65536;
    v = t1 + c + 65535;
    c = Math.floor(v / 65536);
    t1 = v - c * 65536;
    v = t2 + c + 65535;
    c = Math.floor(v / 65536);
    t2 = v - c * 65536;
    v = t3 + c + 65535;
    c = Math.floor(v / 65536);
    t3 = v - c * 65536;
    v = t4 + c + 65535;
    c = Math.floor(v / 65536);
    t4 = v - c * 65536;
    v = t5 + c + 65535;
    c = Math.floor(v / 65536);
    t5 = v - c * 65536;
    v = t6 + c + 65535;
    c = Math.floor(v / 65536);
    t6 = v - c * 65536;
    v = t7 + c + 65535;
    c = Math.floor(v / 65536);
    t7 = v - c * 65536;
    v = t8 + c + 65535;
    c = Math.floor(v / 65536);
    t8 = v - c * 65536;
    v = t9 + c + 65535;
    c = Math.floor(v / 65536);
    t9 = v - c * 65536;
    v = t10 + c + 65535;
    c = Math.floor(v / 65536);
    t10 = v - c * 65536;
    v = t11 + c + 65535;
    c = Math.floor(v / 65536);
    t11 = v - c * 65536;
    v = t12 + c + 65535;
    c = Math.floor(v / 65536);
    t12 = v - c * 65536;
    v = t13 + c + 65535;
    c = Math.floor(v / 65536);
    t13 = v - c * 65536;
    v = t14 + c + 65535;
    c = Math.floor(v / 65536);
    t14 = v - c * 65536;
    v = t15 + c + 65535;
    c = Math.floor(v / 65536);
    t15 = v - c * 65536;
    t0 += c - 1 + 37 * (c - 1);
    c = 1;
    v = t0 + c + 65535;
    c = Math.floor(v / 65536);
    t0 = v - c * 65536;
    v = t1 + c + 65535;
    c = Math.floor(v / 65536);
    t1 = v - c * 65536;
    v = t2 + c + 65535;
    c = Math.floor(v / 65536);
    t2 = v - c * 65536;
    v = t3 + c + 65535;
    c = Math.floor(v / 65536);
    t3 = v - c * 65536;
    v = t4 + c + 65535;
    c = Math.floor(v / 65536);
    t4 = v - c * 65536;
    v = t5 + c + 65535;
    c = Math.floor(v / 65536);
    t5 = v - c * 65536;
    v = t6 + c + 65535;
    c = Math.floor(v / 65536);
    t6 = v - c * 65536;
    v = t7 + c + 65535;
    c = Math.floor(v / 65536);
    t7 = v - c * 65536;
    v = t8 + c + 65535;
    c = Math.floor(v / 65536);
    t8 = v - c * 65536;
    v = t9 + c + 65535;
    c = Math.floor(v / 65536);
    t9 = v - c * 65536;
    v = t10 + c + 65535;
    c = Math.floor(v / 65536);
    t10 = v - c * 65536;
    v = t11 + c + 65535;
    c = Math.floor(v / 65536);
    t11 = v - c * 65536;
    v = t12 + c + 65535;
    c = Math.floor(v / 65536);
    t12 = v - c * 65536;
    v = t13 + c + 65535;
    c = Math.floor(v / 65536);
    t13 = v - c * 65536;
    v = t14 + c + 65535;
    c = Math.floor(v / 65536);
    t14 = v - c * 65536;
    v = t15 + c + 65535;
    c = Math.floor(v / 65536);
    t15 = v - c * 65536;
    t0 += c - 1 + 37 * (c - 1);
    o[0] = t0;
    o[1] = t1;
    o[2] = t2;
    o[3] = t3;
    o[4] = t4;
    o[5] = t5;
    o[6] = t6;
    o[7] = t7;
    o[8] = t8;
    o[9] = t9;
    o[10] = t10;
    o[11] = t11;
    o[12] = t12;
    o[13] = t13;
    o[14] = t14;
    o[15] = t15;
  }
  return ed25519_1;
}
var kem;
var hasRequiredKem;
function requireKem() {
  if (hasRequiredKem) return kem;
  hasRequiredKem = 1;
  var forge2 = requireForge();
  requireUtil();
  requireRandom();
  requireJsbn();
  kem = forge2.kem = forge2.kem || {};
  var BigInteger = forge2.jsbn.BigInteger;
  forge2.kem.rsa = {};
  forge2.kem.rsa.create = function(kdf, options) {
    options = options || {};
    var prng2 = options.prng || forge2.random;
    var kem2 = {};
    kem2.encrypt = function(publicKey, keyLength) {
      var byteLength = Math.ceil(publicKey.n.bitLength() / 8);
      var r;
      do {
        r = new BigInteger(
          forge2.util.bytesToHex(prng2.getBytesSync(byteLength)),
          16
        ).mod(publicKey.n);
      } while (r.compareTo(BigInteger.ONE) <= 0);
      r = forge2.util.hexToBytes(r.toString(16));
      var zeros = byteLength - r.length;
      if (zeros > 0) {
        r = forge2.util.fillString(String.fromCharCode(0), zeros) + r;
      }
      var encapsulation = publicKey.encrypt(r, "NONE");
      var key = kdf.generate(r, keyLength);
      return { encapsulation, key };
    };
    kem2.decrypt = function(privateKey, encapsulation, keyLength) {
      var r = privateKey.decrypt(encapsulation, "NONE");
      return kdf.generate(r, keyLength);
    };
    return kem2;
  };
  forge2.kem.kdf1 = function(md2, digestLength) {
    _createKDF(this, md2, 0, digestLength || md2.digestLength);
  };
  forge2.kem.kdf2 = function(md2, digestLength) {
    _createKDF(this, md2, 1, digestLength || md2.digestLength);
  };
  function _createKDF(kdf, md2, counterStart, digestLength) {
    kdf.generate = function(x, length) {
      var key = new forge2.util.ByteBuffer();
      var k = Math.ceil(length / digestLength) + counterStart;
      var c = new forge2.util.ByteBuffer();
      for (var i = counterStart; i < k; ++i) {
        c.putInt32(i);
        md2.start();
        md2.update(x + c.getBytes());
        var hash = md2.digest();
        key.putBytes(hash.getBytes(digestLength));
      }
      key.truncate(key.length() - length);
      return key.getBytes();
    };
  }
  return kem;
}
var log;
var hasRequiredLog;
function requireLog() {
  if (hasRequiredLog) return log;
  hasRequiredLog = 1;
  var forge2 = requireForge();
  requireUtil();
  log = forge2.log = forge2.log || {};
  forge2.log.levels = [
    "none",
    "error",
    "warning",
    "info",
    "debug",
    "verbose",
    "max"
  ];
  var sLevelInfo = {};
  var sLoggers = [];
  var sConsoleLogger = null;
  forge2.log.LEVEL_LOCKED = 1 << 1;
  forge2.log.NO_LEVEL_CHECK = 1 << 2;
  forge2.log.INTERPOLATE = 1 << 3;
  for (var i = 0; i < forge2.log.levels.length; ++i) {
    var level = forge2.log.levels[i];
    sLevelInfo[level] = {
      index: i,
      name: level.toUpperCase()
    };
  }
  forge2.log.logMessage = function(message) {
    var messageLevelIndex = sLevelInfo[message.level].index;
    for (var i2 = 0; i2 < sLoggers.length; ++i2) {
      var logger2 = sLoggers[i2];
      if (logger2.flags & forge2.log.NO_LEVEL_CHECK) {
        logger2.f(message);
      } else {
        var loggerLevelIndex = sLevelInfo[logger2.level].index;
        if (messageLevelIndex <= loggerLevelIndex) {
          logger2.f(logger2, message);
        }
      }
    }
  };
  forge2.log.prepareStandard = function(message) {
    if (!("standard" in message)) {
      message.standard = sLevelInfo[message.level].name + //' ' + +message.timestamp +
      " [" + message.category + "] " + message.message;
    }
  };
  forge2.log.prepareFull = function(message) {
    if (!("full" in message)) {
      var args = [message.message];
      args = args.concat([]);
      message.full = forge2.util.format.apply(this, args);
    }
  };
  forge2.log.prepareStandardFull = function(message) {
    if (!("standardFull" in message)) {
      forge2.log.prepareStandard(message);
      message.standardFull = message.standard;
    }
  };
  {
    var levels = ["error", "warning", "info", "debug", "verbose"];
    for (var i = 0; i < levels.length; ++i) {
      (function(level2) {
        forge2.log[level2] = function(category, message) {
          var args = Array.prototype.slice.call(arguments).slice(2);
          var msg = {
            timestamp: /* @__PURE__ */ new Date(),
            level: level2,
            category,
            message,
            "arguments": args
            /*standard*/
            /*full*/
            /*fullMessage*/
          };
          forge2.log.logMessage(msg);
        };
      })(levels[i]);
    }
  }
  forge2.log.makeLogger = function(logFunction) {
    var logger2 = {
      flags: 0,
      f: logFunction
    };
    forge2.log.setLevel(logger2, "none");
    return logger2;
  };
  forge2.log.setLevel = function(logger2, level2) {
    var rval = false;
    if (logger2 && !(logger2.flags & forge2.log.LEVEL_LOCKED)) {
      for (var i2 = 0; i2 < forge2.log.levels.length; ++i2) {
        var aValidLevel = forge2.log.levels[i2];
        if (level2 == aValidLevel) {
          logger2.level = level2;
          rval = true;
          break;
        }
      }
    }
    return rval;
  };
  forge2.log.lock = function(logger2, lock2) {
    if (typeof lock2 === "undefined" || lock2) {
      logger2.flags |= forge2.log.LEVEL_LOCKED;
    } else {
      logger2.flags &= ~forge2.log.LEVEL_LOCKED;
    }
  };
  forge2.log.addLogger = function(logger2) {
    sLoggers.push(logger2);
  };
  if (typeof console !== "undefined" && "log" in console) {
    var logger;
    if (console.error && console.warn && console.info && console.debug) {
      var levelHandlers = {
        error: console.error,
        warning: console.warn,
        info: console.info,
        debug: console.debug,
        verbose: console.debug
      };
      var f = function(logger2, message) {
        forge2.log.prepareStandard(message);
        var handler = levelHandlers[message.level];
        var args = [message.standard];
        args = args.concat(message["arguments"].slice());
        handler.apply(console, args);
      };
      logger = forge2.log.makeLogger(f);
    } else {
      var f = function(logger2, message) {
        forge2.log.prepareStandardFull(message);
        console.log(message.standardFull);
      };
      logger = forge2.log.makeLogger(f);
    }
    forge2.log.setLevel(logger, "debug");
    forge2.log.addLogger(logger);
    sConsoleLogger = logger;
  } else {
    console = {
      log: function() {
      }
    };
  }
  if (sConsoleLogger !== null && typeof window !== "undefined" && window.location) {
    var query = new URL(window.location.href).searchParams;
    if (query.has("console.level")) {
      forge2.log.setLevel(
        sConsoleLogger,
        query.get("console.level").slice(-1)[0]
      );
    }
    if (query.has("console.lock")) {
      var lock = query.get("console.lock").slice(-1)[0];
      if (lock == "true") {
        forge2.log.lock(sConsoleLogger);
      }
    }
  }
  forge2.log.consoleLogger = sConsoleLogger;
  return log;
}
var md_all;
var hasRequiredMd_all;
function requireMd_all() {
  if (hasRequiredMd_all) return md_all;
  hasRequiredMd_all = 1;
  md_all = requireMd();
  requireMd5();
  requireSha1();
  requireSha256();
  requireSha512();
  return md_all;
}
var pkcs7 = { exports: {} };
var hasRequiredPkcs7;
function requirePkcs7() {
  if (hasRequiredPkcs7) return pkcs7.exports;
  hasRequiredPkcs7 = 1;
  var forge2 = requireForge();
  requireAes();
  requireAsn1();
  requireDes();
  requireOids();
  requirePem();
  requirePkcs7asn1();
  requireRandom();
  requireUtil();
  requireX509();
  var asn12 = forge2.asn1;
  var p7 = pkcs7.exports = forge2.pkcs7 = forge2.pkcs7 || {};
  p7.messageFromPem = function(pem2) {
    var msg = forge2.pem.decode(pem2)[0];
    if (msg.type !== "PKCS7") {
      var error = new Error('Could not convert PKCS#7 message from PEM; PEM header type is not "PKCS#7".');
      error.headerType = msg.type;
      throw error;
    }
    if (msg.procType && msg.procType.type === "ENCRYPTED") {
      throw new Error("Could not convert PKCS#7 message from PEM; PEM is encrypted.");
    }
    var obj = asn12.fromDer(msg.body);
    return p7.messageFromAsn1(obj);
  };
  p7.messageToPem = function(msg, maxline) {
    var pemObj = {
      type: "PKCS7",
      body: asn12.toDer(msg.toAsn1()).getBytes()
    };
    return forge2.pem.encode(pemObj, { maxline });
  };
  p7.messageFromAsn1 = function(obj) {
    var capture = {};
    var errors = [];
    if (!asn12.validate(obj, p7.asn1.contentInfoValidator, capture, errors)) {
      var error = new Error("Cannot read PKCS#7 message. ASN.1 object is not an PKCS#7 ContentInfo.");
      error.errors = errors;
      throw error;
    }
    var contentType = asn12.derToOid(capture.contentType);
    var msg;
    switch (contentType) {
      case forge2.pki.oids.envelopedData:
        msg = p7.createEnvelopedData();
        break;
      case forge2.pki.oids.encryptedData:
        msg = p7.createEncryptedData();
        break;
      case forge2.pki.oids.signedData:
        msg = p7.createSignedData();
        break;
      default:
        throw new Error("Cannot read PKCS#7 message. ContentType with OID " + contentType + " is not (yet) supported.");
    }
    msg.fromAsn1(capture.content.value[0]);
    return msg;
  };
  p7.createSignedData = function() {
    var msg = null;
    msg = {
      type: forge2.pki.oids.signedData,
      version: 1,
      certificates: [],
      crls: [],
      // TODO: add json-formatted signer stuff here?
      signers: [],
      // populated during sign()
      digestAlgorithmIdentifiers: [],
      contentInfo: null,
      signerInfos: [],
      fromAsn1: function(obj) {
        _fromAsn1(msg, obj, p7.asn1.signedDataValidator);
        msg.certificates = [];
        msg.crls = [];
        msg.digestAlgorithmIdentifiers = [];
        msg.contentInfo = null;
        msg.signerInfos = [];
        if (msg.rawCapture.certificates) {
          var certs = msg.rawCapture.certificates.value;
          for (var i = 0; i < certs.length; ++i) {
            msg.certificates.push(forge2.pki.certificateFromAsn1(certs[i]));
          }
        }
      },
      toAsn1: function() {
        if (!msg.contentInfo) {
          msg.sign();
        }
        var certs = [];
        for (var i = 0; i < msg.certificates.length; ++i) {
          certs.push(forge2.pki.certificateToAsn1(msg.certificates[i]));
        }
        var crls = [];
        var signedData = asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
          asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
            // Version
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.INTEGER,
              false,
              asn12.integerToDer(msg.version).getBytes()
            ),
            // DigestAlgorithmIdentifiers
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.SET,
              true,
              msg.digestAlgorithmIdentifiers
            ),
            // ContentInfo
            msg.contentInfo
          ])
        ]);
        if (certs.length > 0) {
          signedData.value[0].value.push(
            asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, certs)
          );
        }
        if (crls.length > 0) {
          signedData.value[0].value.push(
            asn12.create(asn12.Class.CONTEXT_SPECIFIC, 1, true, crls)
          );
        }
        signedData.value[0].value.push(
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.SET,
            true,
            msg.signerInfos
          )
        );
        return asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.SEQUENCE,
          true,
          [
            // ContentType
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.OID,
              false,
              asn12.oidToDer(msg.type).getBytes()
            ),
            // [0] SignedData
            signedData
          ]
        );
      },
      /**
       * Add (another) entity to list of signers.
       *
       * Note: If authenticatedAttributes are provided, then, per RFC 2315,
       * they must include at least two attributes: content type and
       * message digest. The message digest attribute value will be
       * auto-calculated during signing and will be ignored if provided.
       *
       * Here's an example of providing these two attributes:
       *
       * forge.pkcs7.createSignedData();
       * p7.addSigner({
       *   issuer: cert.issuer.attributes,
       *   serialNumber: cert.serialNumber,
       *   key: privateKey,
       *   digestAlgorithm: forge.pki.oids.sha1,
       *   authenticatedAttributes: [{
       *     type: forge.pki.oids.contentType,
       *     value: forge.pki.oids.data
       *   }, {
       *     type: forge.pki.oids.messageDigest
       *   }]
       * });
       *
       * TODO: Support [subjectKeyIdentifier] as signer's ID.
       *
       * @param signer the signer information:
       *          key the signer's private key.
       *          [certificate] a certificate containing the public key
       *            associated with the signer's private key; use this option as
       *            an alternative to specifying signer.issuer and
       *            signer.serialNumber.
       *          [issuer] the issuer attributes (eg: cert.issuer.attributes).
       *          [serialNumber] the signer's certificate's serial number in
       *           hexadecimal (eg: cert.serialNumber).
       *          [digestAlgorithm] the message digest OID, as a string, to use
       *            (eg: forge.pki.oids.sha1).
       *          [authenticatedAttributes] an optional array of attributes
       *            to also sign along with the content.
       */
      addSigner: function(signer) {
        var issuer = signer.issuer;
        var serialNumber = signer.serialNumber;
        if (signer.certificate) {
          var cert = signer.certificate;
          if (typeof cert === "string") {
            cert = forge2.pki.certificateFromPem(cert);
          }
          issuer = cert.issuer.attributes;
          serialNumber = cert.serialNumber;
        }
        var key = signer.key;
        if (!key) {
          throw new Error(
            "Could not add PKCS#7 signer; no private key specified."
          );
        }
        if (typeof key === "string") {
          key = forge2.pki.privateKeyFromPem(key);
        }
        var digestAlgorithm = signer.digestAlgorithm || forge2.pki.oids.sha1;
        switch (digestAlgorithm) {
          case forge2.pki.oids.sha1:
          case forge2.pki.oids.sha256:
          case forge2.pki.oids.sha384:
          case forge2.pki.oids.sha512:
          case forge2.pki.oids.md5:
            break;
          default:
            throw new Error(
              "Could not add PKCS#7 signer; unknown message digest algorithm: " + digestAlgorithm
            );
        }
        var authenticatedAttributes = signer.authenticatedAttributes || [];
        if (authenticatedAttributes.length > 0) {
          var contentType = false;
          var messageDigest = false;
          for (var i = 0; i < authenticatedAttributes.length; ++i) {
            var attr = authenticatedAttributes[i];
            if (!contentType && attr.type === forge2.pki.oids.contentType) {
              contentType = true;
              if (messageDigest) {
                break;
              }
              continue;
            }
            if (!messageDigest && attr.type === forge2.pki.oids.messageDigest) {
              messageDigest = true;
              if (contentType) {
                break;
              }
              continue;
            }
          }
          if (!contentType || !messageDigest) {
            throw new Error("Invalid signer.authenticatedAttributes. If signer.authenticatedAttributes is specified, then it must contain at least two attributes, PKCS #9 content-type and PKCS #9 message-digest.");
          }
        }
        msg.signers.push({
          key,
          version: 1,
          issuer,
          serialNumber,
          digestAlgorithm,
          signatureAlgorithm: forge2.pki.oids.rsaEncryption,
          signature: null,
          authenticatedAttributes,
          unauthenticatedAttributes: []
        });
      },
      /**
       * Signs the content.
       * @param options Options to apply when signing:
       *    [detached] boolean. If signing should be done in detached mode. Defaults to false.
       */
      sign: function(options) {
        options = options || {};
        if (typeof msg.content !== "object" || msg.contentInfo === null) {
          msg.contentInfo = asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.SEQUENCE,
            true,
            [
              // ContentType
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.OID,
                false,
                asn12.oidToDer(forge2.pki.oids.data).getBytes()
              )
            ]
          );
          if ("content" in msg) {
            var content;
            if (msg.content instanceof forge2.util.ByteBuffer) {
              content = msg.content.bytes();
            } else if (typeof msg.content === "string") {
              content = forge2.util.encodeUtf8(msg.content);
            }
            if (options.detached) {
              msg.detachedContent = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.OCTETSTRING, false, content);
            } else {
              msg.contentInfo.value.push(
                // [0] EXPLICIT content
                asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
                  asn12.create(
                    asn12.Class.UNIVERSAL,
                    asn12.Type.OCTETSTRING,
                    false,
                    content
                  )
                ])
              );
            }
          }
        }
        if (msg.signers.length === 0) {
          return;
        }
        var mds = addDigestAlgorithmIds();
        addSignerInfos(mds);
      },
      verify: function() {
        throw new Error("PKCS#7 signature verification not yet implemented.");
      },
      /**
       * Add a certificate.
       *
       * @param cert the certificate to add.
       */
      addCertificate: function(cert) {
        if (typeof cert === "string") {
          cert = forge2.pki.certificateFromPem(cert);
        }
        msg.certificates.push(cert);
      },
      /**
       * Add a certificate revokation list.
       *
       * @param crl the certificate revokation list to add.
       */
      addCertificateRevokationList: function(crl) {
        throw new Error("PKCS#7 CRL support not yet implemented.");
      }
    };
    return msg;
    function addDigestAlgorithmIds() {
      var mds = {};
      for (var i = 0; i < msg.signers.length; ++i) {
        var signer = msg.signers[i];
        var oid = signer.digestAlgorithm;
        if (!(oid in mds)) {
          mds[oid] = forge2.md[forge2.pki.oids[oid]].create();
        }
        if (signer.authenticatedAttributes.length === 0) {
          signer.md = mds[oid];
        } else {
          signer.md = forge2.md[forge2.pki.oids[oid]].create();
        }
      }
      msg.digestAlgorithmIdentifiers = [];
      for (var oid in mds) {
        msg.digestAlgorithmIdentifiers.push(
          // AlgorithmIdentifier
          asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
            // algorithm
            asn12.create(
              asn12.Class.UNIVERSAL,
              asn12.Type.OID,
              false,
              asn12.oidToDer(oid).getBytes()
            ),
            // parameters (null)
            asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
          ])
        );
      }
      return mds;
    }
    function addSignerInfos(mds) {
      var content;
      if (msg.detachedContent) {
        content = msg.detachedContent;
      } else {
        content = msg.contentInfo.value[1];
        content = content.value[0];
      }
      if (!content) {
        throw new Error(
          "Could not sign PKCS#7 message; there is no content to sign."
        );
      }
      var contentType = asn12.derToOid(msg.contentInfo.value[0].value);
      var bytes = asn12.toDer(content);
      bytes.getByte();
      asn12.getBerValueLength(bytes);
      bytes = bytes.getBytes();
      for (var oid in mds) {
        mds[oid].start().update(bytes);
      }
      var signingTime = /* @__PURE__ */ new Date();
      for (var i = 0; i < msg.signers.length; ++i) {
        var signer = msg.signers[i];
        if (signer.authenticatedAttributes.length === 0) {
          if (contentType !== forge2.pki.oids.data) {
            throw new Error(
              "Invalid signer; authenticatedAttributes must be present when the ContentInfo content type is not PKCS#7 Data."
            );
          }
        } else {
          signer.authenticatedAttributesAsn1 = asn12.create(
            asn12.Class.CONTEXT_SPECIFIC,
            0,
            true,
            []
          );
          var attrsAsn1 = asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.SET,
            true,
            []
          );
          for (var ai = 0; ai < signer.authenticatedAttributes.length; ++ai) {
            var attr = signer.authenticatedAttributes[ai];
            if (attr.type === forge2.pki.oids.messageDigest) {
              attr.value = mds[signer.digestAlgorithm].digest();
            } else if (attr.type === forge2.pki.oids.signingTime) {
              if (!attr.value) {
                attr.value = signingTime;
              }
            }
            attrsAsn1.value.push(_attributeToAsn1(attr));
            signer.authenticatedAttributesAsn1.value.push(_attributeToAsn1(attr));
          }
          bytes = asn12.toDer(attrsAsn1).getBytes();
          signer.md.start().update(bytes);
        }
        signer.signature = signer.key.sign(signer.md, "RSASSA-PKCS1-V1_5");
      }
      msg.signerInfos = _signersToAsn1(msg.signers);
    }
  };
  p7.createEncryptedData = function() {
    var msg = null;
    msg = {
      type: forge2.pki.oids.encryptedData,
      version: 0,
      encryptedContent: {
        algorithm: forge2.pki.oids["aes256-CBC"]
      },
      /**
       * Reads an EncryptedData content block (in ASN.1 format)
       *
       * @param obj The ASN.1 representation of the EncryptedData content block
       */
      fromAsn1: function(obj) {
        _fromAsn1(msg, obj, p7.asn1.encryptedDataValidator);
      },
      /**
       * Decrypt encrypted content
       *
       * @param key The (symmetric) key as a byte buffer
       */
      decrypt: function(key) {
        if (key !== void 0) {
          msg.encryptedContent.key = key;
        }
        _decryptContent(msg);
      }
    };
    return msg;
  };
  p7.createEnvelopedData = function() {
    var msg = null;
    msg = {
      type: forge2.pki.oids.envelopedData,
      version: 0,
      recipients: [],
      encryptedContent: {
        algorithm: forge2.pki.oids["aes256-CBC"]
      },
      /**
       * Reads an EnvelopedData content block (in ASN.1 format)
       *
       * @param obj the ASN.1 representation of the EnvelopedData content block.
       */
      fromAsn1: function(obj) {
        var capture = _fromAsn1(msg, obj, p7.asn1.envelopedDataValidator);
        msg.recipients = _recipientsFromAsn1(capture.recipientInfos.value);
      },
      toAsn1: function() {
        return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
          // ContentType
          asn12.create(
            asn12.Class.UNIVERSAL,
            asn12.Type.OID,
            false,
            asn12.oidToDer(msg.type).getBytes()
          ),
          // [0] EnvelopedData
          asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
            asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
              // Version
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.INTEGER,
                false,
                asn12.integerToDer(msg.version).getBytes()
              ),
              // RecipientInfos
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.SET,
                true,
                _recipientsToAsn1(msg.recipients)
              ),
              // EncryptedContentInfo
              asn12.create(
                asn12.Class.UNIVERSAL,
                asn12.Type.SEQUENCE,
                true,
                _encryptedContentToAsn1(msg.encryptedContent)
              )
            ])
          ])
        ]);
      },
      /**
       * Find recipient by X.509 certificate's issuer.
       *
       * @param cert the certificate with the issuer to look for.
       *
       * @return the recipient object.
       */
      findRecipient: function(cert) {
        var sAttr = cert.issuer.attributes;
        for (var i = 0; i < msg.recipients.length; ++i) {
          var r = msg.recipients[i];
          var rAttr = r.issuer;
          if (r.serialNumber !== cert.serialNumber) {
            continue;
          }
          if (rAttr.length !== sAttr.length) {
            continue;
          }
          var match = true;
          for (var j = 0; j < sAttr.length; ++j) {
            if (rAttr[j].type !== sAttr[j].type || rAttr[j].value !== sAttr[j].value) {
              match = false;
              break;
            }
          }
          if (match) {
            return r;
          }
        }
        return null;
      },
      /**
       * Decrypt enveloped content
       *
       * @param recipient The recipient object related to the private key
       * @param privKey The (RSA) private key object
       */
      decrypt: function(recipient, privKey) {
        if (msg.encryptedContent.key === void 0 && recipient !== void 0 && privKey !== void 0) {
          switch (recipient.encryptedContent.algorithm) {
            case forge2.pki.oids.rsaEncryption:
            case forge2.pki.oids.desCBC:
              var key = privKey.decrypt(recipient.encryptedContent.content);
              msg.encryptedContent.key = forge2.util.createBuffer(key);
              break;
            default:
              throw new Error("Unsupported asymmetric cipher, OID " + recipient.encryptedContent.algorithm);
          }
        }
        _decryptContent(msg);
      },
      /**
       * Add (another) entity to list of recipients.
       *
       * @param cert The certificate of the entity to add.
       */
      addRecipient: function(cert) {
        msg.recipients.push({
          version: 0,
          issuer: cert.issuer.attributes,
          serialNumber: cert.serialNumber,
          encryptedContent: {
            // We simply assume rsaEncryption here, since forge.pki only
            // supports RSA so far.  If the PKI module supports other
            // ciphers one day, we need to modify this one as well.
            algorithm: forge2.pki.oids.rsaEncryption,
            key: cert.publicKey
          }
        });
      },
      /**
       * Encrypt enveloped content.
       *
       * This function supports two optional arguments, cipher and key, which
       * can be used to influence symmetric encryption.  Unless cipher is
       * provided, the cipher specified in encryptedContent.algorithm is used
       * (defaults to AES-256-CBC).  If no key is provided, encryptedContent.key
       * is (re-)used.  If that one's not set, a random key will be generated
       * automatically.
       *
       * @param [key] The key to be used for symmetric encryption.
       * @param [cipher] The OID of the symmetric cipher to use.
       */
      encrypt: function(key, cipher2) {
        if (msg.encryptedContent.content === void 0) {
          cipher2 = cipher2 || msg.encryptedContent.algorithm;
          key = key || msg.encryptedContent.key;
          var keyLen, ivLen, ciphFn;
          switch (cipher2) {
            case forge2.pki.oids["aes128-CBC"]:
              keyLen = 16;
              ivLen = 16;
              ciphFn = forge2.aes.createEncryptionCipher;
              break;
            case forge2.pki.oids["aes192-CBC"]:
              keyLen = 24;
              ivLen = 16;
              ciphFn = forge2.aes.createEncryptionCipher;
              break;
            case forge2.pki.oids["aes256-CBC"]:
              keyLen = 32;
              ivLen = 16;
              ciphFn = forge2.aes.createEncryptionCipher;
              break;
            case forge2.pki.oids["des-EDE3-CBC"]:
              keyLen = 24;
              ivLen = 8;
              ciphFn = forge2.des.createEncryptionCipher;
              break;
            default:
              throw new Error("Unsupported symmetric cipher, OID " + cipher2);
          }
          if (key === void 0) {
            key = forge2.util.createBuffer(forge2.random.getBytes(keyLen));
          } else if (key.length() != keyLen) {
            throw new Error("Symmetric key has wrong length; got " + key.length() + " bytes, expected " + keyLen + ".");
          }
          msg.encryptedContent.algorithm = cipher2;
          msg.encryptedContent.key = key;
          msg.encryptedContent.parameter = forge2.util.createBuffer(
            forge2.random.getBytes(ivLen)
          );
          var ciph = ciphFn(key);
          ciph.start(msg.encryptedContent.parameter.copy());
          ciph.update(msg.content);
          if (!ciph.finish()) {
            throw new Error("Symmetric encryption failed.");
          }
          msg.encryptedContent.content = ciph.output;
        }
        for (var i = 0; i < msg.recipients.length; ++i) {
          var recipient = msg.recipients[i];
          if (recipient.encryptedContent.content !== void 0) {
            continue;
          }
          switch (recipient.encryptedContent.algorithm) {
            case forge2.pki.oids.rsaEncryption:
              recipient.encryptedContent.content = recipient.encryptedContent.key.encrypt(
                msg.encryptedContent.key.data
              );
              break;
            default:
              throw new Error("Unsupported asymmetric cipher, OID " + recipient.encryptedContent.algorithm);
          }
        }
      }
    };
    return msg;
  };
  function _recipientFromAsn1(obj) {
    var capture = {};
    var errors = [];
    if (!asn12.validate(obj, p7.asn1.recipientInfoValidator, capture, errors)) {
      var error = new Error("Cannot read PKCS#7 RecipientInfo. ASN.1 object is not an PKCS#7 RecipientInfo.");
      error.errors = errors;
      throw error;
    }
    return {
      version: capture.version.charCodeAt(0),
      issuer: forge2.pki.RDNAttributesAsArray(capture.issuer),
      serialNumber: forge2.util.createBuffer(capture.serial).toHex(),
      encryptedContent: {
        algorithm: asn12.derToOid(capture.encAlgorithm),
        parameter: capture.encParameter ? capture.encParameter.value : void 0,
        content: capture.encKey
      }
    };
  }
  function _recipientToAsn1(obj) {
    return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // Version
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        asn12.integerToDer(obj.version).getBytes()
      ),
      // IssuerAndSerialNumber
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // Name
        forge2.pki.distinguishedNameToAsn1({ attributes: obj.issuer }),
        // Serial
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.INTEGER,
          false,
          forge2.util.hexToBytes(obj.serialNumber)
        )
      ]),
      // KeyEncryptionAlgorithmIdentifier
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // Algorithm
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(obj.encryptedContent.algorithm).getBytes()
        ),
        // Parameter, force NULL, only RSA supported for now.
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
      ]),
      // EncryptedKey
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OCTETSTRING,
        false,
        obj.encryptedContent.content
      )
    ]);
  }
  function _recipientsFromAsn1(infos) {
    var ret = [];
    for (var i = 0; i < infos.length; ++i) {
      ret.push(_recipientFromAsn1(infos[i]));
    }
    return ret;
  }
  function _recipientsToAsn1(recipients) {
    var ret = [];
    for (var i = 0; i < recipients.length; ++i) {
      ret.push(_recipientToAsn1(recipients[i]));
    }
    return ret;
  }
  function _signerToAsn1(obj) {
    var rval = asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // version
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.INTEGER,
        false,
        asn12.integerToDer(obj.version).getBytes()
      ),
      // issuerAndSerialNumber
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // name
        forge2.pki.distinguishedNameToAsn1({ attributes: obj.issuer }),
        // serial
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.INTEGER,
          false,
          forge2.util.hexToBytes(obj.serialNumber)
        )
      ]),
      // digestAlgorithm
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // algorithm
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(obj.digestAlgorithm).getBytes()
        ),
        // parameters (null)
        asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
      ])
    ]);
    if (obj.authenticatedAttributesAsn1) {
      rval.value.push(obj.authenticatedAttributesAsn1);
    }
    rval.value.push(asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // algorithm
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OID,
        false,
        asn12.oidToDer(obj.signatureAlgorithm).getBytes()
      ),
      // parameters (null)
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.NULL, false, "")
    ]));
    rval.value.push(asn12.create(
      asn12.Class.UNIVERSAL,
      asn12.Type.OCTETSTRING,
      false,
      obj.signature
    ));
    if (obj.unauthenticatedAttributes.length > 0) {
      var attrsAsn1 = asn12.create(asn12.Class.CONTEXT_SPECIFIC, 1, true, []);
      for (var i = 0; i < obj.unauthenticatedAttributes.length; ++i) {
        var attr = obj.unauthenticatedAttributes[i];
        attrsAsn1.values.push(_attributeToAsn1(attr));
      }
      rval.value.push(attrsAsn1);
    }
    return rval;
  }
  function _signersToAsn1(signers) {
    var ret = [];
    for (var i = 0; i < signers.length; ++i) {
      ret.push(_signerToAsn1(signers[i]));
    }
    return ret;
  }
  function _attributeToAsn1(attr) {
    var value;
    if (attr.type === forge2.pki.oids.contentType) {
      value = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OID,
        false,
        asn12.oidToDer(attr.value).getBytes()
      );
    } else if (attr.type === forge2.pki.oids.messageDigest) {
      value = asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OCTETSTRING,
        false,
        attr.value.bytes()
      );
    } else if (attr.type === forge2.pki.oids.signingTime) {
      var jan_1_1950 = /* @__PURE__ */ new Date("1950-01-01T00:00:00Z");
      var jan_1_2050 = /* @__PURE__ */ new Date("2050-01-01T00:00:00Z");
      var date = attr.value;
      if (typeof date === "string") {
        var timestamp = Date.parse(date);
        if (!isNaN(timestamp)) {
          date = new Date(timestamp);
        } else if (date.length === 13) {
          date = asn12.utcTimeToDate(date);
        } else {
          date = asn12.generalizedTimeToDate(date);
        }
      }
      if (date >= jan_1_1950 && date < jan_1_2050) {
        value = asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.UTCTIME,
          false,
          asn12.dateToUtcTime(date)
        );
      } else {
        value = asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.GENERALIZEDTIME,
          false,
          asn12.dateToGeneralizedTime(date)
        );
      }
    }
    return asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
      // AttributeType
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OID,
        false,
        asn12.oidToDer(attr.type).getBytes()
      ),
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SET, true, [
        // AttributeValue
        value
      ])
    ]);
  }
  function _encryptedContentToAsn1(ec) {
    return [
      // ContentType, always Data for the moment
      asn12.create(
        asn12.Class.UNIVERSAL,
        asn12.Type.OID,
        false,
        asn12.oidToDer(forge2.pki.oids.data).getBytes()
      ),
      // ContentEncryptionAlgorithmIdentifier
      asn12.create(asn12.Class.UNIVERSAL, asn12.Type.SEQUENCE, true, [
        // Algorithm
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OID,
          false,
          asn12.oidToDer(ec.algorithm).getBytes()
        ),
        // Parameters (IV)
        !ec.parameter ? void 0 : asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OCTETSTRING,
          false,
          ec.parameter.getBytes()
        )
      ]),
      // [0] EncryptedContent
      asn12.create(asn12.Class.CONTEXT_SPECIFIC, 0, true, [
        asn12.create(
          asn12.Class.UNIVERSAL,
          asn12.Type.OCTETSTRING,
          false,
          ec.content.getBytes()
        )
      ])
    ];
  }
  function _fromAsn1(msg, obj, validator) {
    var capture = {};
    var errors = [];
    if (!asn12.validate(obj, validator, capture, errors)) {
      var error = new Error("Cannot read PKCS#7 message. ASN.1 object is not a supported PKCS#7 message.");
      error.errors = error;
      throw error;
    }
    var contentType = asn12.derToOid(capture.contentType);
    if (contentType !== forge2.pki.oids.data) {
      throw new Error("Unsupported PKCS#7 message. Only wrapped ContentType Data supported.");
    }
    if (capture.encryptedContent) {
      var content = "";
      if (forge2.util.isArray(capture.encryptedContent)) {
        for (var i = 0; i < capture.encryptedContent.length; ++i) {
          if (capture.encryptedContent[i].type !== asn12.Type.OCTETSTRING) {
            throw new Error("Malformed PKCS#7 message, expecting encrypted content constructed of only OCTET STRING objects.");
          }
          content += capture.encryptedContent[i].value;
        }
      } else {
        content = capture.encryptedContent;
      }
      msg.encryptedContent = {
        algorithm: asn12.derToOid(capture.encAlgorithm),
        parameter: forge2.util.createBuffer(capture.encParameter.value),
        content: forge2.util.createBuffer(content)
      };
    }
    if (capture.content) {
      var content = "";
      if (forge2.util.isArray(capture.content)) {
        for (var i = 0; i < capture.content.length; ++i) {
          if (capture.content[i].type !== asn12.Type.OCTETSTRING) {
            throw new Error("Malformed PKCS#7 message, expecting content constructed of only OCTET STRING objects.");
          }
          content += capture.content[i].value;
        }
      } else {
        content = capture.content;
      }
      msg.content = forge2.util.createBuffer(content);
    }
    msg.version = capture.version.charCodeAt(0);
    msg.rawCapture = capture;
    return capture;
  }
  function _decryptContent(msg) {
    if (msg.encryptedContent.key === void 0) {
      throw new Error("Symmetric key not available.");
    }
    if (msg.content === void 0) {
      var ciph;
      switch (msg.encryptedContent.algorithm) {
        case forge2.pki.oids["aes128-CBC"]:
        case forge2.pki.oids["aes192-CBC"]:
        case forge2.pki.oids["aes256-CBC"]:
          ciph = forge2.aes.createDecryptionCipher(msg.encryptedContent.key);
          break;
        case forge2.pki.oids["desCBC"]:
        case forge2.pki.oids["des-EDE3-CBC"]:
          ciph = forge2.des.createDecryptionCipher(msg.encryptedContent.key);
          break;
        default:
          throw new Error("Unsupported symmetric cipher, OID " + msg.encryptedContent.algorithm);
      }
      ciph.start(msg.encryptedContent.parameter);
      ciph.update(msg.encryptedContent.content);
      if (!ciph.finish()) {
        throw new Error("Symmetric decryption failed.");
      }
      msg.content = ciph.output;
    }
  }
  return pkcs7.exports;
}
var ssh = { exports: {} };
var hasRequiredSsh;
function requireSsh() {
  if (hasRequiredSsh) return ssh.exports;
  hasRequiredSsh = 1;
  var forge2 = requireForge();
  requireAes();
  requireHmac();
  requireMd5();
  requireSha1();
  requireUtil();
  var ssh$1 = ssh.exports = forge2.ssh = forge2.ssh || {};
  ssh$1.privateKeyToPutty = function(privateKey, passphrase, comment) {
    comment = comment || "";
    passphrase = passphrase || "";
    var algorithm = "ssh-rsa";
    var encryptionAlgorithm = passphrase === "" ? "none" : "aes256-cbc";
    var ppk = "PuTTY-User-Key-File-2: " + algorithm + "\r\n";
    ppk += "Encryption: " + encryptionAlgorithm + "\r\n";
    ppk += "Comment: " + comment + "\r\n";
    var pubbuffer = forge2.util.createBuffer();
    _addStringToBuffer(pubbuffer, algorithm);
    _addBigIntegerToBuffer(pubbuffer, privateKey.e);
    _addBigIntegerToBuffer(pubbuffer, privateKey.n);
    var pub = forge2.util.encode64(pubbuffer.bytes(), 64);
    var length = Math.floor(pub.length / 66) + 1;
    ppk += "Public-Lines: " + length + "\r\n";
    ppk += pub;
    var privbuffer = forge2.util.createBuffer();
    _addBigIntegerToBuffer(privbuffer, privateKey.d);
    _addBigIntegerToBuffer(privbuffer, privateKey.p);
    _addBigIntegerToBuffer(privbuffer, privateKey.q);
    _addBigIntegerToBuffer(privbuffer, privateKey.qInv);
    var priv;
    if (!passphrase) {
      priv = forge2.util.encode64(privbuffer.bytes(), 64);
    } else {
      var encLen = privbuffer.length() + 16 - 1;
      encLen -= encLen % 16;
      var padding = _sha1(privbuffer.bytes());
      padding.truncate(padding.length() - encLen + privbuffer.length());
      privbuffer.putBuffer(padding);
      var aeskey = forge2.util.createBuffer();
      aeskey.putBuffer(_sha1("\0\0\0\0", passphrase));
      aeskey.putBuffer(_sha1("\0\0\0", passphrase));
      var cipher2 = forge2.aes.createEncryptionCipher(aeskey.truncate(8), "CBC");
      cipher2.start(forge2.util.createBuffer().fillWithByte(0, 16));
      cipher2.update(privbuffer.copy());
      cipher2.finish();
      var encrypted = cipher2.output;
      encrypted.truncate(16);
      priv = forge2.util.encode64(encrypted.bytes(), 64);
    }
    length = Math.floor(priv.length / 66) + 1;
    ppk += "\r\nPrivate-Lines: " + length + "\r\n";
    ppk += priv;
    var mackey = _sha1("putty-private-key-file-mac-key", passphrase);
    var macbuffer = forge2.util.createBuffer();
    _addStringToBuffer(macbuffer, algorithm);
    _addStringToBuffer(macbuffer, encryptionAlgorithm);
    _addStringToBuffer(macbuffer, comment);
    macbuffer.putInt32(pubbuffer.length());
    macbuffer.putBuffer(pubbuffer);
    macbuffer.putInt32(privbuffer.length());
    macbuffer.putBuffer(privbuffer);
    var hmac2 = forge2.hmac.create();
    hmac2.start("sha1", mackey);
    hmac2.update(macbuffer.bytes());
    ppk += "\r\nPrivate-MAC: " + hmac2.digest().toHex() + "\r\n";
    return ppk;
  };
  ssh$1.publicKeyToOpenSSH = function(key, comment) {
    var type = "ssh-rsa";
    comment = comment || "";
    var buffer = forge2.util.createBuffer();
    _addStringToBuffer(buffer, type);
    _addBigIntegerToBuffer(buffer, key.e);
    _addBigIntegerToBuffer(buffer, key.n);
    return type + " " + forge2.util.encode64(buffer.bytes()) + " " + comment;
  };
  ssh$1.privateKeyToOpenSSH = function(privateKey, passphrase) {
    if (!passphrase) {
      return forge2.pki.privateKeyToPem(privateKey);
    }
    return forge2.pki.encryptRsaPrivateKey(
      privateKey,
      passphrase,
      { legacy: true, algorithm: "aes128" }
    );
  };
  ssh$1.getPublicKeyFingerprint = function(key, options) {
    options = options || {};
    var md2 = options.md || forge2.md.md5.create();
    var type = "ssh-rsa";
    var buffer = forge2.util.createBuffer();
    _addStringToBuffer(buffer, type);
    _addBigIntegerToBuffer(buffer, key.e);
    _addBigIntegerToBuffer(buffer, key.n);
    md2.start();
    md2.update(buffer.getBytes());
    var digest = md2.digest();
    if (options.encoding === "hex") {
      var hex = digest.toHex();
      if (options.delimiter) {
        return hex.match(/.{2}/g).join(options.delimiter);
      }
      return hex;
    } else if (options.encoding === "binary") {
      return digest.getBytes();
    } else if (options.encoding) {
      throw new Error('Unknown encoding "' + options.encoding + '".');
    }
    return digest;
  };
  function _addBigIntegerToBuffer(buffer, val) {
    var hexVal = val.toString(16);
    if (hexVal[0] >= "8") {
      hexVal = "00" + hexVal;
    }
    var bytes = forge2.util.hexToBytes(hexVal);
    buffer.putInt32(bytes.length);
    buffer.putBytes(bytes);
  }
  function _addStringToBuffer(buffer, val) {
    buffer.putInt32(val.length);
    buffer.putString(val);
  }
  function _sha1() {
    var sha = forge2.md.sha1.create();
    var num = arguments.length;
    for (var i = 0; i < num; ++i) {
      sha.update(arguments[i]);
    }
    return sha.digest();
  }
  return ssh.exports;
}
var lib;
var hasRequiredLib;
function requireLib() {
  if (hasRequiredLib) return lib;
  hasRequiredLib = 1;
  lib = requireForge();
  requireAes();
  requireAesCipherSuites();
  requireAsn1();
  requireCipher();
  requireDes();
  requireEd25519();
  requireHmac();
  requireKem();
  requireLog();
  requireMd_all();
  requireMgf1();
  requirePbkdf2();
  requirePem();
  requirePkcs1();
  requirePkcs12();
  requirePkcs7();
  requirePki();
  requirePrime();
  requirePrng();
  requirePss();
  requireRandom();
  requireRc2();
  requireSsh();
  requireTls();
  requireUtil();
  return lib;
}
var libExports = requireLib();
const forge = /* @__PURE__ */ heavyWorkWorker.getDefaultExportFromCjs(libExports);
const SIGNATURE_HEADER = "MCPB_SIG_V1";
const SIGNATURE_FOOTER = "MCPB_SIG_END";
const execFileAsync = require$$0$1.promisify(require$$1$2.execFile);
async function verifyMcpbFile(mcpbPath) {
  var _a, _b, _c, _d;
  try {
    const fileContent = require$$0$2.readFileSync(mcpbPath);
    const { originalContent, pkcs7Signature } = extractSignatureBlock(fileContent);
    if (!pkcs7Signature) {
      return { status: "unsigned" };
    }
    const asn12 = forge.asn1.fromDer(pkcs7Signature.toString("binary"));
    const p7Message = forge.pkcs7.messageFromAsn1(asn12);
    if (!("type" in p7Message) || p7Message.type !== forge.pki.oids.signedData) {
      return { status: "unsigned" };
    }
    const p7 = p7Message;
    const certificates = p7.certificates || [];
    if (certificates.length === 0) {
      return { status: "unsigned" };
    }
    const signingCert = certificates[0];
    const contentBuf = forge.util.createBuffer(originalContent);
    try {
      p7.verify({ authenticatedAttributes: true });
      const signerInfos = p7.signerInfos;
      const signerInfo = signerInfos == null ? void 0 : signerInfos[0];
      if (signerInfo) {
        const md2 = forge.md.sha256.create();
        md2.update(contentBuf.getBytes());
        const digest = md2.digest().getBytes();
        let messageDigest = null;
        for (const attr of signerInfo.authenticatedAttributes) {
          if (attr.type === forge.pki.oids.messageDigest) {
            messageDigest = attr.value;
            break;
          }
        }
        if (!messageDigest || messageDigest !== digest) {
          return { status: "unsigned" };
        }
      }
    } catch (error) {
      return { status: "unsigned" };
    }
    const certPem = forge.pki.certificateToPem(signingCert);
    const intermediatePems = certificates.slice(1).map((cert) => Buffer.from(forge.pki.certificateToPem(cert)));
    const chainValid = await verifyCertificateChain(Buffer.from(certPem), intermediatePems);
    if (!chainValid) {
      return { status: "unsigned" };
    }
    const isSelfSigned = ((_a = signingCert.issuer.getField("CN")) == null ? void 0 : _a.value) === ((_b = signingCert.subject.getField("CN")) == null ? void 0 : _b.value);
    return {
      status: isSelfSigned ? "self-signed" : "signed",
      publisher: ((_c = signingCert.subject.getField("CN")) == null ? void 0 : _c.value) || "Unknown",
      issuer: ((_d = signingCert.issuer.getField("CN")) == null ? void 0 : _d.value) || "Unknown",
      valid_from: signingCert.validity.notBefore.toISOString(),
      valid_to: signingCert.validity.notAfter.toISOString(),
      fingerprint: forge.md.sha256.create().update(forge.asn1.toDer(forge.pki.certificateToAsn1(signingCert)).getBytes()).digest().toHex()
    };
  } catch (error) {
    throw new Error(`Failed to verify MCPB file: ${error}`);
  }
}
function extractSignatureBlock(fileContent) {
  const footerBytes = Buffer.from(SIGNATURE_FOOTER, "utf-8");
  const footerIndex = fileContent.lastIndexOf(footerBytes);
  if (footerIndex === -1) {
    return { originalContent: fileContent };
  }
  const headerBytes = Buffer.from(SIGNATURE_HEADER, "utf-8");
  let headerIndex = -1;
  for (let i = footerIndex - 1; i >= 0; i--) {
    if (fileContent.slice(i, i + headerBytes.length).equals(headerBytes)) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) {
    return { originalContent: fileContent };
  }
  const originalContent = fileContent.slice(0, headerIndex);
  let offset = headerIndex + headerBytes.length;
  try {
    const sigLength = fileContent.readUInt32LE(offset);
    offset += 4;
    const pkcs7Signature = fileContent.slice(offset, offset + sigLength);
    return {
      originalContent,
      pkcs7Signature
    };
  } catch {
    return { originalContent: fileContent };
  }
}
async function verifyCertificateChain(certificate, intermediates) {
  let tempDir = null;
  try {
    tempDir = await fs$2.mkdtemp(require$$1.join(require$$1$1.tmpdir(), "mcpb-verify-"));
    const certChainPath = require$$1.join(tempDir, "chain.pem");
    const certChain = [certificate, ...intermediates || []].join("\n");
    await fs$2.writeFile(certChainPath, certChain);
    if (process.platform === "darwin") {
      try {
        await execFileAsync("security", [
          "verify-cert",
          "-c",
          certChainPath,
          "-p",
          "codeSign"
        ]);
        return true;
      } catch (error) {
        return false;
      }
    } else if (process.platform === "win32") {
      const psCommand = `
        $ErrorActionPreference = 'Stop'
        $certCollection = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
        $certCollection.Import('${certChainPath}')
        
        if ($certCollection.Count -eq 0) {
          Write-Error 'No certificates found'
          exit 1
        }
        
        $leafCert = $certCollection[0]
        $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
        
        # Enable revocation checking
        $chain.ChainPolicy.RevocationMode = 'Online'
        $chain.ChainPolicy.RevocationFlag = 'EntireChain'
        $chain.ChainPolicy.UrlRetrievalTimeout = New-TimeSpan -Seconds 30
        
        # Add code signing application policy
        $codeSignOid = New-Object System.Security.Cryptography.Oid '1.3.6.1.5.5.7.3.3'
        $chain.ChainPolicy.ApplicationPolicy.Add($codeSignOid)
        
        # Add intermediate certificates to extra store
        for ($i = 1; $i -lt $certCollection.Count; $i++) {
          [void]$chain.ChainPolicy.ExtraStore.Add($certCollection[$i])
        }
        
        # Build and validate chain
        $result = $chain.Build($leafCert)
        
        if ($result) { 
          'Valid' 
        } else { 
          $chain.ChainStatus | ForEach-Object { 
            Write-Error "$($_.Status): $($_.StatusInformation)"
          }
          exit 1 
        }
      `.trim();
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        psCommand
      ]);
      return stdout.includes("Valid");
    } else {
      try {
        await execFileAsync("openssl", [
          "verify",
          "-purpose",
          "codesigning",
          "-CApath",
          "/etc/ssl/certs",
          certChainPath
        ]);
        return true;
      } catch (error) {
        return false;
      }
    }
  } catch (error) {
    return false;
  } finally {
    if (tempDir) {
      try {
        await fs$2.rm(tempDir, { recursive: true, force: true });
      } catch {
      }
    }
  }
}
unionType([
  McpbManifestSchema$3,
  McpbManifestSchema$2,
  McpbManifestSchema$1,
  McpbManifestSchema
]);
recordType(stringType(), unionType([stringType(), numberType(), booleanType(), arrayType(stringType())]));
strictObjectType({
  status: enumType(["signed", "unsigned", "self-signed"]),
  publisher: stringType().optional(),
  issuer: stringType().optional(),
  valid_from: stringType().optional(),
  valid_to: stringType().optional(),
  fingerprint: stringType().optional()
});
exports.extractSignatureBlock = extractSignatureBlock;
exports.verifyCertificateChain = verifyCertificateChain;
exports.verifyMcpbFile = verifyMcpbFile;
