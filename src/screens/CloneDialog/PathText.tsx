import { Fragment } from "react";
import { cn } from "../../ui/cn";

/**
 * A path that only wraps at its separators (and only in the middle of a name as a last resort).
 * Selectable, in the code font.
 */
export function WrappingPath({ path, className }: { path: string; className?: string }) {
  // Separators stay at the end of their part; a line break may follow them.
  const parts = path.split(/(?<=[\\/])/);
  return (
    <span className={cn("selectable font-mono text-code break-words", className)}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </span>
  );
}
