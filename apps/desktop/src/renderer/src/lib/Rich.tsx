import { Fragment } from 'react'

/** Renders a translation whose words in <b>…</b> are emphasized (the only markup allowed). */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/<b>(.*?)<\/b>/g).map((part, i) =>
        i % 2 ? (
          <strong key={i} className="font-semibold">
            {part}
          </strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  )
}
