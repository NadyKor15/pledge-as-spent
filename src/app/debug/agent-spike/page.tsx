import { AgentDebug } from "./AgentDebug";

// Debug page of the live agent: the closed demo drive, the "Ask the book" widget and
// AG Studio with our agent attached. ?mode=recorded&q=Q1 plays a recorded run, ?mode=script plays a
// fixed script without any model, ?mode=live asks Nova through /api/agent/*. &lang=de|ja.
// Local runs only: src/app/debug/layout.tsx hides /debug/* in production unless DEBUG_PAGES=on.
export default function AgentDebugPage() {
  return <AgentDebug />;
}
