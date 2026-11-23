import { d, type Decoder, type Infer } from "../src/lib/decode.ts"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
function expectType<T extends true>() {}
const schema = d.object({
  required: d.string(),
  optional: d.string().optional(),
  nullable: d.number().nullable(),
  enabled: d.boolean().default(false),
  status: d.enum(["on", "off"]),
  rows: d.array(d.object({ name: d.string() })),
})
type Value = Infer<typeof schema>
expectType<Equal<Value["required"], string>>()
expectType<Equal<Value["optional"], string | undefined>>()
expectType<Equal<Value["nullable"], number | null>>()
expectType<Equal<Value["enabled"], boolean>>()
expectType<Equal<Value["status"], "on" | "off">>()
expectType<Equal<Value["rows"], { name: string }[]>>()
const valid: Value = { required: "", nullable: null, enabled: false, status: "on", rows: [] }
void valid
// @ts-expect-error required fields remain required
const missing: Value = { nullable: null, enabled: false, status: "on", rows: [] }
// @ts-expect-error default fields are required in the decoded output
const noDefault: Value = { required: "", nullable: 0, status: "on", rows: [] }
// @ts-expect-error enum is a literal union, not string
const status: Value["status"] = "other"
void missing; void noDefault; void status
const extended = schema.extend({ required: d.number(), extra: d.string().optional() })
expectType<Equal<Infer<typeof extended>["required"], number>>()
expectType<Equal<Infer<typeof extended>["extra"], string | undefined>>()
const base = d.object({ model: d.string() })
const union = d.union([base.extend({ effort: d.string() }), base])
const favorite = union.parse({})
if ("effort" in favorite) expectType<Equal<typeof favorite.effort, string>>()
expectType<Equal<Infer<ReturnType<typeof d.unknown>>, unknown>>()
expectType<Equal<Infer<ReturnType<typeof d.number>>, number>>()
expectType<Equal<Infer<ReturnType<typeof d.boolean>>, boolean>>()
expectType<Equal<Infer<ReturnType<typeof d.string>>, string>>()
expectType<Equal<Infer<ReturnType<typeof d.string>["array"] extends (...args: never[]) => infer R ? R : never>, string[]>>()
function generic<T>(decoder: Decoder<T>): T { return decoder.parse(null) }
expectType<Equal<ReturnType<typeof generic<string>>, string>>()
const result = schema.safeParse({})
if (result.success) expectType<Equal<typeof result.data, Value>>()
else result.error.path satisfies readonly (string | number)[]
