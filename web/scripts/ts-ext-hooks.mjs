const hasExtension = (specifier) =>
  /\.(?:[cm]?[jt]sx?|json|node|wasm)$/.test(specifier);

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !hasExtension(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}
