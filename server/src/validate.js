// Parameter check against the tool's inputSchema. PingOne tool parameters are camelCase; a snake_case or unknown name
// is silently wrong, not rejected (pingone-mcp skill). Warnings only: never blocks a call.
const camel = (s) => s.replace(/_+([a-z0-9])/gi, (_, c) => c.toUpperCase());

export function validateArgs(inputSchema, args) {
  const warnings = [];
  const props = inputSchema && typeof inputSchema === 'object' ? inputSchema.properties : null;
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!props || typeof props !== 'object') return warnings;
  const open = inputSchema.additionalProperties === true;
  for (const k of Object.keys(a)) {
    if (k in props) continue;
    const alt = camel(k);
    if (k.includes('_') && alt in props) warnings.push({ param: k, kind: 'snake_case', message: `"${k}" is snake_case; this server uses camelCase. Did you mean "${alt}"? A wrong-case name is silently ignored.` });
    else if (!open) warnings.push({ param: k, kind: 'unknown', message: `"${k}" is not a parameter of this tool; it will probably be ignored.` });
  }
  for (const r of Array.isArray(inputSchema.required) ? inputSchema.required : []) {
    if (!(r in a)) warnings.push({ param: r, kind: 'missing', message: `required parameter "${r}" is missing.` });
  }
  return warnings;
}
