type ClosableResource = { end?: () => Promise<unknown> | unknown; close?: () => Promise<unknown> | unknown };

const resources = new Set<ClosableResource>();

export function registerTestResource<T extends ClosableResource>(resource: T): T {
  resources.add(resource);
  return resource;
}

export async function closeRegisteredTestResources(): Promise<void> {
  const pending = Array.from(resources);
  resources.clear();
  await Promise.all(
    pending.map(async resource => {
      try {
        if (typeof resource.end === "function") await resource.end();
        else if (typeof resource.close === "function") await resource.close();
      } catch {
        // Individual test files may already have closed a resource. Global teardown
        // must remain best-effort and must not mask the suite's actual result.
      }
    }),
  );
}
