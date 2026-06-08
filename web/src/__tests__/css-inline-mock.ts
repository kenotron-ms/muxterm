// Stub for CSS ?inline imports in the test environment.
// node_modules is a symlink to the parent workspace; Vite's filesystem security
// rejects the resolved real path when CSS ?inline imports are processed.
// The CSS is not needed in unit tests (no actual rendering happens).
export default '';
