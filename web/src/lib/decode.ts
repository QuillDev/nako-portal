/** Small runtime decoders for the portal's JSON boundaries. Objects strip unknown keys. */
type Path = readonly (string | number)[]
export class DecodeError extends Error {
  constructor(readonly path: Path, expected: string) {
    super(`${path.length ? path.join(".") : "value"}: expected ${expected}`)
    this.name = "DecodeError"
  }
}
const fail = (path: Path, expected: string): never => { throw new DecodeError(path, expected) }
export type Infer<D extends Decoder<unknown>> = D extends Decoder<infer T> ? T : never

type Result<T> = { success: true; data: T } | { success: false; error: DecodeError }
export class Decoder<T> {
  constructor(readonly read: (input: unknown, path: Path) => T) {}
  parse(input: unknown): T { return this.read(input, []) }
  safeParse(input: unknown): Result<T> {
    try { return { success: true, data: this.parse(input) } } catch (error) {
      if (!(error instanceof DecodeError)) throw error
      return { success: false, error }
    }
  }
  optional(): Decoder<T | undefined> {
    return new Decoder((input, path) => input === undefined ? undefined : this.read(input, path))
  }
  array(): Decoder<T[]> { return d.array(this) }
  nullable(): Decoder<T | null> {
    return new Decoder((input, path) => input === null ? null : this.read(input, path))
  }
  default(value: Exclude<T, undefined>): Decoder<Exclude<T, undefined>> {
    return new Decoder((input, path) => input === undefined ? value : this.read(input, path) as Exclude<T, undefined>)
  }
}

class StringDecoder extends Decoder<string> {
  constructor(read = (input: unknown, path: Path): string => typeof input === "string" ? input : fail(path, "string")) { super(read) }
  trim(): StringDecoder { return new StringDecoder((input, path) => this.read(input, path).trim()) }
  min(length: number): StringDecoder {
    return new StringDecoder((input, path) => {
      const value = this.read(input, path)
      return value.length >= length ? value : fail(path, `at least ${length} characters`)
    })
  }
  max(length: number): StringDecoder {
    return new StringDecoder((input, path) => {
      const value = this.read(input, path)
      return value.length <= length ? value : fail(path, `at most ${length} characters`)
    })
  }
}

type Shape = Record<string, Decoder<unknown>>
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S]
type Fields<T> = { [K in keyof T]: T[K] }
type ObjectValue<S extends Shape> = Fields<{ [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } &
  { [K in OptionalKeys<S>]?: Infer<S[K]> }>
class ObjectDecoder<S extends Shape> extends Decoder<ObjectValue<S>> {
  constructor(readonly shape: S) {
    super((input, path) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return fail(path, "object")
      const source = input as Record<string, unknown>
      const entries = Object.entries(shape).flatMap(([key, decoder]) => {
        const value = decoder.read(source[key], [...path, key])
        return value !== undefined || key in source ? [[key, value]] : []
      })
      return Object.fromEntries(entries) as ObjectValue<S>
    })
  }
  extend<E extends Shape>(extra: E): ObjectDecoder<Omit<S, keyof E> & E> {
    return new ObjectDecoder({ ...this.shape, ...extra } as Omit<S, keyof E> & E)
  }
}

export const d = {
  string: () => new StringDecoder(),
  number: () => new Decoder<number>((input, path) =>
    typeof input === "number" && Number.isFinite(input) ? input : fail(path, "finite number")),
  boolean: () => new Decoder<boolean>((input, path) => typeof input === "boolean" ? input : fail(path, "boolean")),
  unknown: () => new Decoder<unknown>(input => input),
  enum: <const T extends readonly [string, ...string[]]>(values: T) => new Decoder<T[number]>((input, path) =>
    typeof input === "string" && values.includes(input) ? input : fail(path, values.join(" | "))),
  array: <T>(item: Decoder<T>) => new Decoder<T[]>((input, path) => {
    if (!Array.isArray(input)) return fail(path, "array")
    return Array.from(input, (value, index) => item.read(value, [...path, index]))
  }),
  object: <S extends Shape>(shape: S) => new ObjectDecoder(shape),
  union: <const D extends readonly [Decoder<unknown>, ...Decoder<unknown>[]]>(choices: D) =>
    new Decoder<Infer<D[number]>>((input, path) => {
      for (const choice of choices) {
        try { return choice.read(input, path) as Infer<D[number]> } catch (error) {
          if (!(error instanceof DecodeError)) throw error
        }
      }
      return fail(path, "a union member")
    }),
}
