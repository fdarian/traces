const SERVICE_HUES = [20, 50, 80, 120, 160, 200, 240, 280, 320, 350, 30, 70];

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function serviceColor(name: string): string {
  const h = hashString(name);
  const hue = SERVICE_HUES[h % SERVICE_HUES.length];
  return `oklch(0.72 0.12 ${hue})`;
}

/**
 * Compact pill that renders a service name with a deterministic hue derived
 * from the name string.
 *
 * @example
 * ```tsx
 * <ServiceBadge name="checkout-service" />
 * ```
 */
export function ServiceBadge(props: { readonly name: string }) {
  const color = serviceColor(props.name);
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-label font-medium uppercase tracking-wide"
      style={{
        backgroundColor: color.replace('oklch(0.72 0.12', 'oklch(0.72 0.06'),
        color,
      }}
    >
      {props.name}
    </span>
  );
}

/** Returns the deterministic oklch color string for a service name. */
export function serviceColorValue(name: string): string {
  return serviceColor(name);
}
