const errorCodes = new Set([
  'uia_node_unavailable', 'uia_children_unavailable',
  'msaa_node_unavailable', 'msaa_children_unavailable', 'accessibility_unavailable'
]);

// Accessibility providers can put UI text in exception messages. Only expose
// protocol codes and counts; unknown diagnostics still make the read incomplete.
export function observationErrors(errors) {
  if (errors === undefined || errors === null) return [];
  const entries = Array.isArray(errors) ? errors : [errors];
  const counts = new Map();
  for (const error of entries) {
    const code = errorCodes.has(error?.code) ? error.code : 'accessibility_unavailable';
    const count = Number.isSafeInteger(error?.count) && error.count > 0 ? error.count : 1;
    counts.set(code, Math.min(Number.MAX_SAFE_INTEGER, (counts.get(code) ?? 0) + count));
  }
  return [...counts].map(([code, count]) => ({ code, count }));
}

export function incompleteReasons(snapshot) {
  return [
    ...(snapshot?.truncation?.truncated === true ? [{ code: 'tree_truncated', count: 1 }] : []),
    ...(snapshot?.truncation?.maxDepthReached === true ? [{ code: 'max_depth_reached', count: 1 }] : []),
    ...observationErrors(snapshot?.observationErrors)
  ];
}
