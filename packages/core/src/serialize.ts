import type { AttributeValue } from './model.js';

export type SerializableJson =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<SerializableJson>
  | { readonly [key: string]: SerializableJson };

export type SerializableAttributeValue = {
  readonly key: string;
  readonly value: SerializableJson;
};

export function serializeValue(value: unknown): SerializableJson | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items: Array<SerializableJson> = [];
    for (const item of value) {
      const serialized = serializeValue(item);
      items.push(serialized === undefined ? null : serialized);
    }
    return items;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, SerializableJson> = {};
    for (const key of Object.keys(record)) {
      const serialized = serializeValue(record[key]);
      if (serialized !== undefined) {
        result[key] = serialized;
      }
    }
    return result;
  }
  return String(value);
}

export function serializeAttribute(
  attribute: AttributeValue,
): SerializableAttributeValue | null {
  if (attribute.value === undefined) {
    return null;
  }
  const value = serializeValue(attribute.value);
  if (value === undefined) {
    return null;
  }
  return {
    key: attribute.key,
    value,
  };
}
