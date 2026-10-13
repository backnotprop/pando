// The message box under a conversation: what to say, a quiet line under it,
// and Send (or Command-Enter). It is cleared once the message is taken.
// `beside`: a control next to Send (the assistant's project choice).
import { type ReactNode, useState } from "react";
import { button, Refusal } from "../ui/controls";

export function Composer({ placeholder, hint, send, beside }: { placeholder: string; hint: string; send: (text: string) => Promise<void>; beside?: ReactNode }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const go = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);

    try {
      await send(text.trim());
      setText("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-1 rounded-xl border border-rootline bg-air p-3 focus-within:border-ash"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go();
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={2}
        className="resize-none bg-transparent text-[14.5px] leading-[22px] text-bark placeholder:text-ash focus:outline-none"
      />
      <Refusal error={error} />
      <div className="flex items-center gap-2">
        <span className="mr-auto text-[12.5px] text-ash">{hint}</span>
        {beside}
        <button type="submit" className={button("solid", 30)} disabled={!text.trim() || busy}>
          Send
        </button>
      </div>
    </form>
  );
}
