import { useState } from "react"
import { Confirmation, ConfirmationAction, ConfirmationActions, ConfirmationRequest, ConfirmationTitle } from "@/components/ai-elements/confirmation"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Portal } from "@/hooks/use-portal"
import type { PortalRequest } from "@/lib/types"

const APPROVAL_LABELS: Record<string, string> = { once: "Allow once", session: "Allow this session", always: "Always allow", deny: "Deny" }

function Approval({ request, answer }: { request: PortalRequest; answer: Portal["answer"] }) {
  const p = request.params
  return (
    <Confirmation approval={{ id: request.id }} state="approval-requested">
      <ConfirmationTitle>
        <span className="font-medium">Needs your ok.</span> {p.description}
      </ConfirmationTitle>
      {p.command && <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{p.command}</pre>}
      <ConfirmationRequest>
        <ConfirmationActions className="flex-wrap justify-start">
          {(p.choices || []).map(choice => (
            <ConfirmationAction key={choice} onClick={() => answer(request.id, { choice })} variant={choice === "deny" ? "outline" : "default"}>
              {APPROVAL_LABELS[choice] || choice}
            </ConfirmationAction>
          ))}
        </ConfirmationActions>
      </ConfirmationRequest>
    </Confirmation>
  )
}

// AI Elements has no multiple-question element, so a clarify request is its questions
// with the offered choices as suggestions and a free-text answer for each.
function Clarify({ request, answer }: { request: PortalRequest; answer: Portal["answer"] }) {
  const questions = request.params.questions || []
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const pick = (qid: string, value: string) => {
    if (questions.length === 1) return answer(request.id, { answers: { [qid]: value } })
    setAnswers(a => ({ ...a, [qid]: value }))
  }
  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      {questions.map(q => (
        <div className="flex flex-col gap-2" key={q.qid}>
          <p className="text-sm">{q.question}</p>
          {(q.choices || []).length > 0 && (
            <Suggestions>
              {q.choices!.map(choice => (
                <Suggestion key={choice} onClick={value => pick(q.qid, value)} suggestion={choice} />
              ))}
            </Suggestions>
          )}
          <Input aria-label={q.question} onChange={e => setAnswers(a => ({ ...a, [q.qid]: e.target.value }))} placeholder="Your answer" value={answers[q.qid] || ""} />
        </div>
      ))}
      <div>
        <Button
          onClick={() => answer(request.id, { answers: Object.fromEntries(questions.map(q => [q.qid, answers[q.qid]?.trim() || null])) })}
          size="sm"
        >
          Answer
        </Button>
      </div>
    </div>
  )
}

export function Requests({ requests, answer }: { requests: PortalRequest[]; answer: Portal["answer"] }) {
  return requests.map(r =>
    r.method === "approval" ? (
      <Approval answer={answer} key={r.id} request={r} />
    ) : r.method === "clarify" ? (
      <Clarify answer={answer} key={r.id} request={r} />
    ) : (
      <p className="rounded-lg border p-4 text-muted-foreground text-sm" key={r.id}>
        {r.method}: this one needs the desktop app.
      </p>
    ),
  )
}
