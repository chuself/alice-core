/**
 * Where the TENANT lives — the single most important line in the package.
 *
 * Every module used to compute its root as `path.resolve(import.meta.dirname,
 * "..")`. That was correct while the engine WAS the repository. Now that it is
 * a dependency, that expression points at `node_modules/alice-core/`, so the
 * queue would read empty, posters would be written into node_modules, and
 * nothing would throw. The run would simply do nothing, successfully.
 *
 * So the root is resolved from the working directory instead: the tenant repo
 * is where the CLI is invoked. ALICE_TENANT_DIR overrides it for tests and for
 * anything that needs to run from elsewhere.
 */
import path from "node:path";

export const ROOT = path.resolve(process.env.ALICE_TENANT_DIR ?? process.cwd());

/** Join onto the tenant root. Use this rather than re-deriving paths. */
export function tenantPath(...parts) {
  return path.join(ROOT, ...parts);
}
