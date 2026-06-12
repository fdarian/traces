import type { ReactNode } from 'react';
import { useState } from 'react';

export function CopyText(props: {
  readonly value: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`cursor-pointer transition-colors duration-120 hover:text-accent ${props.className ?? ''}`}
      title={copied ? 'copied' : 'click to copy'}
    >
      {props.children ?? props.value}
    </button>
  );
}
