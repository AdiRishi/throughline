import type { RepositoryPath } from "@app/contracts";

export const isRepositoryPath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

export const repositoryPath = (path: string): RepositoryPath => {
  if (!isRepositoryPath(path)) {
    throw new RangeError(`Unsafe repository path: ${JSON.stringify(path)}`);
  }
  return path as RepositoryPath;
};
