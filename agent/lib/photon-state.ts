import { createRedisState } from "@chat-adapter/state-redis";

/** Delay credential resolution until Chat SDK uses storage, not template build. */
export function createPhotonState(): ReturnType<typeof createRedisState> {
  let state: ReturnType<typeof createRedisState> | undefined;
  return new Proxy({} as ReturnType<typeof createRedisState>, {
    get(_target, key) {
      return (...args: unknown[]) => {
        const url = process.env.REDIS_URL?.trim();
        if (!url) throw new Error("Set REDIS_URL to this deployment's durable Redis store.");
        state ??= createRedisState({ url });
        return Reflect.apply(Reflect.get(state, key), state, args);
      };
    },
  });
}
