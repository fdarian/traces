const LIBRARY_MARKERS = [
  'node_modules',
  'vendor/',
  '/site-packages/',
  'venv/',
  '.venv/',
  'dist/',
  'webpack/',
];

export interface StackFrame {
  readonly raw: string;
  readonly path: string;
  readonly functionName: string;
  readonly lineNumber: string;
  readonly isLibrary: boolean;
}

function isLibraryPath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const marker of LIBRARY_MARKERS) {
    if (lower.includes(marker)) {
      return true;
    }
  }
  return false;
}

function parseFrameLine(line: string): StackFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const atMatch = trimmed.match(/^at\s+(.+?)\s+\((.+):(\d+):?(\d+)?\)$/);
  if (atMatch !== null) {
    const functionName = atMatch[1] ?? '';
    const path = atMatch[2] ?? '';
    const linePart = atMatch[3] ?? '';
    const colPart = atMatch[4];
    const lineNumber =
      colPart !== undefined ? `${linePart}:${colPart}` : linePart;
    return {
      raw: trimmed,
      path,
      functionName,
      lineNumber,
      isLibrary: isLibraryPath(path),
    };
  }

  const javaMatch = trimmed.match(/^at\s+([\w.$]+)\(([^:]+):(\d+)\)$/);
  if (javaMatch !== null) {
    const functionName = javaMatch[1] ?? '';
    const path = javaMatch[2] ?? '';
    const lineNumber = javaMatch[3] ?? '';
    return {
      raw: trimmed,
      path,
      functionName,
      lineNumber,
      isLibrary: isLibraryPath(path),
    };
  }

  const pythonMatch = trimmed.match(
    /^File\s+"(.+)",\s+line\s+(\d+),\s+in\s+(.+)$/,
  );
  if (pythonMatch !== null) {
    const path = pythonMatch[1] ?? '';
    const lineNumber = pythonMatch[2] ?? '';
    const functionName = pythonMatch[3] ?? '';
    return {
      raw: trimmed,
      path,
      functionName,
      lineNumber,
      isLibrary: isLibraryPath(path),
    };
  }

  if (trimmed.startsWith('at ')) {
    const remainder = trimmed.slice(3);
    return {
      raw: trimmed,
      path: remainder,
      functionName: remainder,
      lineNumber: '',
      isLibrary: isLibraryPath(remainder),
    };
  }

  return {
    raw: trimmed,
    path: '',
    functionName: trimmed,
    lineNumber: '',
    isLibrary: false,
  };
}

/** Parses a raw stacktrace string (Node/Java/Python format) into structured `StackFrame` objects. */
export function parseStackFrames(
  stacktrace: string,
): ReadonlyArray<StackFrame> {
  const lines = stacktrace.split('\n');
  const frames: Array<StackFrame> = [];
  for (const line of lines) {
    const frame = parseFrameLine(line);
    if (frame !== null) {
      frames.push(frame);
    }
  }
  return frames;
}

/**
 * Renders a parsed exception stacktrace with the exception type and message
 * header. Library frames (node_modules, vendor, etc.) are dimmed at 0.6 opacity.
 *
 * @example
 * ```tsx
 * <StacktraceBlock
 *   type="TypeError"
 *   message="Cannot read properties of undefined"
 *   stacktrace={span.exceptionStacktrace}
 * />
 * ```
 */
export function StacktraceBlock(props: {
  readonly type: string;
  readonly message: string;
  readonly stacktrace: string;
}) {
  const frames = parseStackFrames(props.stacktrace);

  return (
    <div className="rounded border border-border-subtle bg-bg-inset p-3">
      <div className="mb-2 font-data text-data text-text-primary">
        <span className="text-status-error">{props.type}</span>
        {props.message.length > 0 && (
          <span className="text-text-secondary">: {props.message}</span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 font-data text-data">
        {frames.map((frame, index) => (
          <div
            key={`${frame.raw}-${index}`}
            className="flex items-baseline justify-between gap-3"
            style={{ opacity: frame.isLibrary ? 0.6 : 1 }}
          >
            <div className="min-w-0 flex-1">
              {frame.path.length > 0 && (
                <span className="text-text-tertiary">{frame.path}</span>
              )}
              {frame.path.length > 0 && frame.functionName.length > 0 && (
                <span className="text-text-tertiary"> · </span>
              )}
              <span className="text-text-primary">{frame.functionName}</span>
            </div>
            {frame.lineNumber.length > 0 && (
              <span className="shrink-0 text-text-tertiary">
                {frame.lineNumber}
              </span>
            )}
          </div>
        ))}
        {frames.length === 0 && props.stacktrace.length > 0 && (
          <pre className="whitespace-pre-wrap text-text-secondary">
            {props.stacktrace}
          </pre>
        )}
      </div>
    </div>
  );
}
