import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import queryString from 'query-string';
import realAxios, {
  AxiosError,
  AxiosInstance,
  Method,
  AxiosRequestConfig,
  AxiosPromise,
} from 'axios';
import createProxy from './proxy';
import { transformKeys, caseMethods, transformKey } from './case';

export type UrlBuilder<ReturnType> = {
  [segment: string]: UrlBuilder<ReturnType>;
  (params?: object, config?: AxiosRequestConfig):
    | Promise<ReturnType>
    | ReturnType;
};

type Subscription = (key: string) => void;
type Subscribers = Set<React.RefObject<Subscription>>;

type Cache = Map<
  string,
  {
    subscribersCount: number;
    dependentKeys: string[];
    value: unknown;
    promise: Promise<unknown> | null;
    deletionTimeout: ReturnType<typeof setTimeout> | null;
  }
>;

function useForceUpdate() {
  // @TODO this should be a low priority update when concurrent mode is stable
  const update = useState({})[1];

  const forceUpdate = () => {
    update({});
  };

  return forceUpdate;
}

function isPromise(value: any) {
  return value && typeof value.then === 'function';
}

export function createApi<BaseType>(
  axios: AxiosInstance = realAxios,
  {
    requestCase = 'snake',
    responseCase = 'camel',
    urlCase = requestCase,
    modifier = x => x,
    deduplicationStrategy = () => ({}),
    cache = new Map(),
    onUpdateCache = () => {},
  }: {
    requestCase?: 'snake' | 'camel' | 'constant' | 'pascal' | 'kebab' | 'none';
    responseCase?: 'snake' | 'camel' | 'constant' | 'pascal' | 'kebab' | 'none';
    urlCase?: 'snake' | 'camel' | 'constant' | 'pascal' | 'kebab' | 'none';
    modifier?: (data: unknown, loadUrl: (url: string) => unknown) => any;
    deduplicationStrategy?: (data: any) => { [url: string]: any };
    cache?: Cache;
    onUpdateCache?: () => void;
  } = {}
) {
  const caseToServer = caseMethods[requestCase];
  const caseFromServer = caseMethods[responseCase];
  const caseForUrls = caseMethods[urlCase];

  /** Set of refs of callbacks for components subscribing to any api call */
  const subscribers: Subscribers = new Set();
  /** Whether or not calling an api will subscribe this component, used in preload */
  let doSubscription = true;

  let realOnUpdateCache = onUpdateCache;
  let onUpdateCacheTimeout: ReturnType<typeof setTimeout> | null = null;
  onUpdateCache = function() {
    if (onUpdateCacheTimeout) clearTimeout(onUpdateCacheTimeout);
    onUpdateCacheTimeout = setTimeout(() => {
      realOnUpdateCache();
      clearTimeout(onUpdateCacheTimeout!);
    }, 0);
  };

  function setKey(key: string, value: unknown) {
    const item = cache.get(key);
    const subscribersCount = item ? item.subscribersCount : 0;
    const existingValue = item ? item.value : undefined;
    const dependentKeys = item ? item.dependentKeys : [];
    const deletionTimeout = item ? item.deletionTimeout : null;

    if (deletionTimeout) {
      clearTimeout(deletionTimeout);
    }

    // registering promises in the cache does not require
    // subscribing components to update.
    if (isPromise(value)) {
      cache.set(key, {
        value: existingValue,
        promise: value as Promise<unknown>,
        subscribersCount,
        dependentKeys,
        deletionTimeout: null,
      });

      return;
    }

    if (value instanceof Error) {
      // Give an error if this should throw an error
      cache.set(key, {
        get value() {
          throw value;
        },
        promise: null,
        subscribersCount,
        dependentKeys,
        deletionTimeout: null,
      });
    } else {
      const otherKeys = deduplicationStrategy(value);
      const dependentKeys = Object.keys(otherKeys);

      cache.set(key, {
        value,
        promise: null,
        subscribersCount,
        dependentKeys,
        deletionTimeout: null,
      });

      for (let key in otherKeys) {
        if (!cache.get(key)) {
          cache.set(key, {
            value: otherKeys[key],
            promise: null,
            subscribersCount: 0,
            dependentKeys: [],
            deletionTimeout: null,
          });
        }
      }
    }

    subscribers.forEach(ref => ref.current && ref.current(key));
    onUpdateCache();
  }

  function loadUrl(
    key: string,
    subscribeComponentTo?: (url: string) => void
  ): BaseType {
    if (subscribeComponentTo) subscribeComponentTo(key);

    const {
      value = undefined,
      promise: existingPromise = undefined,
      deletionTimeout,
    } = cache.get(key) || {};

    if (deletionTimeout) {
      clearTimeout(deletionTimeout);
    }

    // return early if the value is already loaded
    if (value !== undefined) {
      return modifier(value, key => loadUrl(key, subscribeComponentTo));
    }

    // piggy back promises to the same key
    if (isPromise(existingPromise)) {
      throw existingPromise;
    }

    // if the value is not yet loaded, create a promise that will load the value
    const promise = axios({
      url: key,
      method: 'get',
    })
      .then(async ({ data }: { data: any }) => {
        data = transformKeys(data, caseFromServer);

        setKey(key, data);
      })
      .catch((err: AxiosError) => {
        // not found errors can just set null
        if (err.response && err.response.status === 404)
          return setKey(key, null);

        // every other error should throw
        setKey(key, err);
      });

    setKey(key, promise);

    throw promise;
  }

  function createAxiosProxy<T = BaseType>(
    getSuspendedValue: (url: string) => undefined | T
  ) {
    const api = createProxy<T>(
      caseForUrls,
      (
        method: Method,
        path: string,
        params: object,
        options: Partial<AxiosRequestConfig>
      ) => {
        const qs = queryString.stringify(transformKeys(params, caseToServer), {
          arrayFormat: 'bracket',
        });

        const url = path + (qs ? `?${qs}` : '');

        let suspended = getSuspendedValue(url);
        if (suspended !== undefined) return suspended;

        return axios({
          method,
          url,
          ...options,
          data:
            'data' in options
              ? transformKeys(options.data, caseToServer)
              : undefined,
        })
          .then(res => {
            res.data = transformKeys(res.data, caseFromServer);
            return res;
          })
          .catch(err => {
            if (err.response) {
              err.response.data = transformKeys(
                err.response.data,
                caseFromServer
              );
            }
            throw err;
          }) as AxiosPromise;
      }
    );

    return api;
  }

  async function touchWithMatcher(
    matcher: (key: string, value: BaseType) => boolean
  ) {
    let keysToReset = [];

    // find the keys that these edges touch. E.g. `users` should touch `/users/1`
    const cacheKeys = Array.from(cache.keys());
    for (let cacheKey of cacheKeys) {
      const item = cache.get(cacheKey)!;
      if (!matcher(cacheKey, item.value as BaseType)) continue;
      if (item.subscribersCount <= 0) {
        if (item.deletionTimeout) clearTimeout(item.deletionTimeout);
        cache.delete(cacheKey);
        continue;
      }

      keysToReset.push(cacheKey);
    }

    const keyValues = await Promise.all(
      keysToReset.map(cacheKey => {
        const refresh = async () => {
          // re-run the axios call. This should be an a similar call to the call in `loadUrl`
          const data = await axios({
            url: cacheKey,
            method: 'get',
          })
            .then(({ data }) => {
              // run the transform here and not in setKey in case there is an error
              return transformKeys(data, caseFromServer);
            })
            .catch(err => {
              if (err.response) {
                if (err.response.status === 404) return null;
                else {
                  err.response.data = transformKeys(
                    err.response.data,
                    caseFromServer
                  );
                }
              }

              return err;
            });

          return [cacheKey, data];
        };

        const promise = refresh();
        setKey(cacheKey, promise);

        return promise;
      })
    );

    for (let [key, value] of keyValues) {
      setKey(key, value);
    }

    onUpdateCache();
  }

  async function touch(...edges: string[]) {
    const casedEdges = edges.map(edge => transformKey(edge, caseToServer));
    return touchWithMatcher(str => casedEdges.some(edge => str.includes(edge)));
  }

  /**
   * @example
   *   const api = useApi()
   *   const users = api.users() as User[]
   *   // do something with users
   */
  function useApi() {
    const keysRef = useRef(new Set<string>());
    const previousKeysRef = useRef(new Set<string>());

    // If the previous render suspended, the pending keys will be in keysRef.
    // This is to make sure those are included as potential "previous keys".
    keysRef.current.forEach(key => previousKeysRef.current.add(key));
    keysRef.current = new Set<string>();

    // We want this component to throw on all requests while it is in the render phase
    // but not after. This effect switches it to non-suspending after the commit.
    let isSuspending = true;
    useLayoutEffect(() => {
      isSuspending = false;
    });

    const forceUpdate = useForceUpdate();
    const subscription = useRef<Subscription>(changedKey => {
      if (!keysRef.current.has(changedKey)) return;
      forceUpdate();
    });

    // Add/remove this component from subscriber list on mount/unmount
    useEffect(() => {
      subscribers.add(subscription);
      return () => {
        subscribers.delete(subscription);

        const keys = Array.from(keysRef.current);

        for (let key of keys) {
          const item = cache.get(key);
          // this shouldn't happen but if
          // it does we don't want to crash
          /* istanbul ignore next  */
          if (!item) continue;
          item.subscribersCount -= 1;
          if (item.subscribersCount <= 0) {
            deferRemoveKey(key);
          }
        }
      };
    }, []);

    useLayoutEffect(() => {
      // @TODO this could be optimized or use set methods when those are released
      const newKeys = Array.from(keysRef.current).filter(
        key => !previousKeysRef.current.has(key)
      );

      const removedKeys = Array.from(previousKeysRef.current).filter(
        key => !keysRef.current.has(key)
      );

      // count up new keys
      for (let key of newKeys) {
        const item = cache.get(key);
        // this shouldn't happen but if
        // it does we don't want to crash
        /* istanbul ignore next  */
        if (!item) continue;
        item.subscribersCount += 1;
      }

      // and count down old keys until they are removed
      for (let key of removedKeys) {
        const item = cache.get(key);
        // this shouldn't happen but if
        // it does we don't want to crash
        /* istanbul ignore next  */
        if (!item) continue;
        item.subscribersCount -= 1;
        if (item.subscribersCount <= 0) {
          deferRemoveKey(key);
        }
      }

      previousKeysRef.current = keysRef.current;
    });

    const api = createAxiosProxy<BaseType>(url => {
      if (!isSuspending && doSubscription) return undefined;
      else {
        return loadUrl(url, (url: string) => {
          if (!doSubscription) return;
          if (!keysRef.current.has(url)) keysRef.current.add(url);
        });
      }
    });

    return api;
  }

  function deferRemoveKey(key: string) {
    const item = cache.get(key);
    if (!item) return;

    const timeout = setTimeout(() => {
      const item = cache.get(key);
      if (!item) return;
      cache.delete(key);

      // Find all records dependant on this record and
      // remove those that have no subscribers.
      const { dependentKeys } = item;
      for (let dependentKey of dependentKeys) {
        const dependentItem = cache.get(dependentKey);
        // this shouldn't happen but if
        // it does we don't want to crash
        /* istanbul ignore next  */
        if (!dependentItem) continue;
        if (dependentItem.subscribersCount <= 0) cache.delete(dependentKey);
      }
    }, 1000 * 60 * 3);

    item.deletionTimeout = timeout;
  }

  /**
   * @example
   *   const axiosResponse = await api.comments.post({}, { data: { body: '123' }})
   */

  const api = createAxiosProxy<BaseType>(url => {
    if (doSubscription) return undefined;
    return loadUrl(url);
  });

  function reset() {
    cache = new Map();
  }

  /**
   * Preload api calls without suspending or subscribing this component
   * Returns a promise that is fulfilled when the request(s) are cached.
   * @param fns functions that may suspend
   * @example
   *
   * const api = useApi() // using the hook is necessary
   *
   * preload(() => {
   *   api.users(); // preload users without suspending or subscribing this component
   * });
   *
   * preload(() => {
   *   api.posts(); // preload posts
   * });
   *
   * preload(() => {
   *   // also works with multiple calls
   *   const user = api.users.me();
   *   const tasks = api.tasks({ userId: user.id });
   * });
   *
   */
  async function preload(fn: () => void) {
    // continue until success
    while (true) {
      try {
        doSubscription = false;
        fn();
        doSubscription = true;
        break;
      } catch (e) {
        doSubscription = true;
        if (!isPromise(e)) throw e;
        // make sure promise fires
        await e;
      }
    }
  }

  function save() {
    const returned: { [key: string]: unknown } = {};
    cache.forEach(({ value }, key) => {
      if (value !== undefined) returned[key] = value;
    });
    return returned;
  }

  function restore(saveFile: { [key: string]: unknown }) {
    for (let [key, value] of Object.entries(saveFile)) {
      if (!cache.has(key)) {
        cache.set(key, {
          value,
          promise: null,
          subscribersCount: 0,
          dependentKeys: [],
          deletionTimeout: null,
        });
      }
    }
  }

  return {
    touch,
    touchWithMatcher,
    useApi,
    api,
    reset,
    preload,
    save,
    restore,
  };
}

export function defer<T>(call: () => T, defaultValue?: T) {
  try {
    return { data: call(), loading: false };
  } catch (e) {
    if (!isPromise(e)) throw e;

    return { data: defaultValue, loading: true };
  }
}
