import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Paper-and-ink markdown renderer for coder messages (MESSAGE.md prose).
 *
 * Styled by element overrides rather than a typography plugin so it speaks the
 * project's design tokens directly: serif prose on `--ink`, mono for code,
 * hairlines instead of fills, no shadows. Raw HTML is intentionally not enabled
 * (react-markdown ignores it by default) and link URLs are sanitized — the body
 * is untrusted agent output.
 */

const COMPONENTS: Components = {
  p: ({ children }) => <p className="leading-snug">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-sanguine underline decoration-hairline-deep underline-offset-2 hover:text-sanguine-deep"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-ink">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => (
    <del className="text-ink-muted line-through">{children}</del>
  ),
  ul: ({ children }) => (
    <ul className="list-disc space-y-1 pl-5 leading-snug marker:text-ink-faint">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal space-y-1 pl-5 leading-snug marker:text-ink-faint">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="[&>ol]:mt-1 [&>ul]:mt-1">{children}</li>
  ),
  h1: ({ children }) => (
    <h2 className="text-[1.2em] font-semibold leading-tight text-ink">
      {children}
    </h2>
  ),
  h2: ({ children }) => (
    <h3 className="text-[1.1em] font-semibold leading-tight text-ink">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="font-semibold leading-tight text-ink">{children}</h4>
  ),
  h4: ({ children }) => (
    <h5 className="font-mono text-[0.8em] uppercase tracking-caps text-ink-muted">
      {children}
    </h5>
  ),
  h5: ({ children }) => (
    <h6 className="font-mono text-[0.8em] uppercase tracking-caps text-ink-muted">
      {children}
    </h6>
  ),
  h6: ({ children }) => (
    <h6 className="font-mono text-[0.8em] uppercase tracking-caps text-ink-muted">
      {children}
    </h6>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l border-hairline-deep pl-3 italic text-ink-soft">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-hairline" />,
  // Inline code; block code lives inside `pre`, which neutralizes these styles.
  code: ({ children }) => (
    <code className="border border-hairline bg-paper-edge px-1 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto border border-hairline bg-paper-deep p-2.5 font-mono text-[0.85em] leading-snug [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[0.9em]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-hairline px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-hairline px-2 py-1 align-top">{children}</td>
  ),
  input: (props) =>
    props.type === 'checkbox' ? (
      <input
        {...props}
        className="mr-1 translate-y-px accent-sanguine"
        disabled
      />
    ) : (
      <input {...props} />
    ),
};

export function Markdown({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={`font-serif text-ink [overflow-wrap:anywhere] [&>*+*]:mt-2 ${className}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
