/**
 * Runtime validation utilities for tool arguments
 */

import { JSONSchema } from '../types/index.js';

export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
    public value?: unknown,
    public schema?: JSONSchema
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate a value against a JSON Schema
 */
export function validateSchema(value: unknown, schema: JSONSchema, path = ''): void {
  switch (schema.type) {
    case 'string':
      validateString(value, schema, path);
      break;
    case 'number':
      validateNumber(value, schema, path);
      break;
    case 'boolean':
      validateBoolean(value, schema, path);
      break;
    case 'array':
      validateArray(value, schema, path);
      break;
    case 'object':
      validateObject(value, schema, path);
      break;
    case 'null':
      if (value !== null) {
        throw new ValidationError(
          `Expected null at ${path}, got ${typeof value}`,
          path,
          value,
          schema
        );
      }
      break;
    default:
      // Handle union types like ['string', 'number', 'boolean', 'null']
      if (Array.isArray(schema.type)) {
        const valid = schema.type.some((type) => {
          try {
            validateSchema(value, { ...schema, type }, path);
            return true;
          } catch {
            return false;
          }
        });
        if (!valid) {
          throw new ValidationError(
            `Expected one of [${schema.type.join(', ')}] at ${path}, got ${typeof value}`,
            path,
            value,
            schema
          );
        }
      }
  }
}

function validateString(value: unknown, schema: JSONSchema, path: string): void {
  if (typeof value !== 'string') {
    throw new ValidationError(
      `Expected string at ${path}, got ${typeof value}`,
      path,
      value,
      schema
    );
  }

  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new ValidationError(
      `String at ${path} must be at least ${schema.minLength} characters long`,
      path,
      value,
      schema
    );
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new ValidationError(
      `String at ${path} must be at most ${schema.maxLength} characters long`,
      path,
      value,
      schema
    );
  }

  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    throw new ValidationError(
      `String at ${path} must match pattern ${schema.pattern}`,
      path,
      value,
      schema
    );
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    throw new ValidationError(
      `String at ${path} must be one of [${schema.enum.join(', ')}]`,
      path,
      value,
      schema
    );
  }
}

function validateNumber(value: unknown, schema: JSONSchema, path: string): void {
  if (typeof value !== 'number') {
    throw new ValidationError(
      `Expected number at ${path}, got ${typeof value}`,
      path,
      value,
      schema
    );
  }

  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new ValidationError(
      `Number at ${path} must be at least ${schema.minimum}`,
      path,
      value,
      schema
    );
  }

  if (schema.maximum !== undefined && value > schema.maximum) {
    throw new ValidationError(
      `Number at ${path} must be at most ${schema.maximum}`,
      path,
      value,
      schema
    );
  }
}

function validateBoolean(value: unknown, schema: JSONSchema, path: string): void {
  if (typeof value !== 'boolean') {
    throw new ValidationError(
      `Expected boolean at ${path}, got ${typeof value}`,
      path,
      value,
      schema
    );
  }
}

function validateArray(value: unknown, schema: JSONSchema, path: string): void {
  if (!Array.isArray(value)) {
    throw new ValidationError(
      `Expected array at ${path}, got ${typeof value}`,
      path,
      value,
      schema
    );
  }

  if (schema.items) {
    value.forEach((item, index) => {
      validateSchema(item, schema.items!, `${path}[${index}]`);
    });
  }
}

function validateObject(value: unknown, schema: JSONSchema, path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(
      `Expected object at ${path}, got ${typeof value}`,
      path,
      value,
      schema
    );
  }

  const obj = value as Record<string, unknown>;

  // Check required properties
  if (schema.required) {
    for (const required of schema.required) {
      if (!(required in obj)) {
        throw new ValidationError(
          `Missing required property '${required}' at ${path}`,
          `${path}.${required}`,
          undefined,
          schema
        );
      }
    }
  }

  // Validate properties
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in obj) {
        validateSchema(obj[key], propSchema, `${path}.${key}`);
      }
    }
  }
}

/**
 * Create a validator function for a specific schema
 */
export function createValidator<T>(schema: JSONSchema): (value: unknown) => T {
  return (value: unknown): T => {
    validateSchema(value, schema);
    return value as T;
  };
}

/**
 * Safe type assertion with validation
 */
export function assertType<T>(value: unknown, schema: JSONSchema): T {
  validateSchema(value, schema);
  return value as T;
}
