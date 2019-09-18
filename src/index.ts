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
  (params?: object, config?: object): Promise<ReturnType> | ReturnType;
};

type Subscription = (key: string) => void;
type Subscribers = Set<React.RefObject<Subscription>>;

type Cache = Map<
  string,
  {
    subscribersCount: number;
    value: unknown;
    promise: Promise<unknown> | null;
  }
>;

function useForceUpdate() {
  // @TODO this should be a low priority update when concurrent mode is done
  const update = useState({})[1];

  const forceUpdate = () => {
    update({});
  };

  return forceUpdate;
}

function isPromise(value: any) {
  return value && typeof value.then === 'function';
}

export function createApi(
  axios: AxiosInstance = realAxios,
  {
    requestCase = 'snake',
    responseCase = 'camel',
    modifier = x => x,
  }: {
    requestCase?: 'snake' | 'camel' | 'constant' | 'pascal' | 'none';
    responseCase?: 'snake' | 'camel' | 'constant' | 'pascal' | 'none';
    modifier?: (data: unknown, loadUrl: (url: string) => unknown) => any;
  } = {}
) {
  const caseToServer = caseMethods[requestCase];
  const caseFromServer = caseMethods[responseCase];

  let cache: Cache = new Map();
  const subscribers: Subscribers = new Set();

  function setKey(key: string, value: unknown) {
    const subscribersCount = cache.has(key)
      ? cache.get(key)!.subscribersCount
      : 0;

    // registering promises in the cache does not require
    // subscribing components to update.
    if (isPromise(value)) {
      cache.set(key, {
        value: undefined,
        promise: value as Promise<unknown>,
        subscribersCount,
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
      });
    } else {
      cache.set(key, { value, promise: null, subscribersCount });
    }

    subscribers.forEach(ref => ref.current && ref.current(key));
  }

  function loadUrl(
    key: string,
    subscribeComponentTo: (url: string) => void
  ): unknown {
    subscribeComponentTo(key);

    const { value = undefined, promise: existingPromise = undefined } =
      cache.get(key) || {};

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

  async function touch(...edges: string[]) {
    let keysToReset = [];
    const casedEdges = edges.map(edge => transformKey(edge, caseToServer));

    // find the keys that these edges touch. E.g. `users` should touch `/users/1`
    const cacheKeys = Array.from(cache.keys());
    for (let key of casedEdges) {
      for (let cacheKey of cacheKeys) {
        if (!cacheKey.includes(key)) continue;
        keysToReset.push(cacheKey);
      }
    }

    const keyValues = await Promise.all(
      keysToReset.map(async cacheKey => {
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
      })
    );

    for (let [key, value] of keyValues) {
      setKey(key, value);
    }
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
        cache.get(key)!.subscribersCount += 1;
      }

      // and count down old keys until they are removed
      for (let key of removedKeys) {
        cache.get(key)!.subscribersCount -= 1;
        if (cache.get(key)!.subscribersCount <= 0) {
          cache.delete(key);
        }
      }

      previousKeysRef.current = keysRef.current;
    });

    // @TODO it would be nice to be able to specify a schema for query builders
    const api = createProxy<unknown>(
      caseToServer,
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

        if (!isSuspending) {
          return axios({
            ...options,
            data:
              'data' in options
                ? transformKeys(options.data, caseToServer)
                : undefined,
            method,
            url,
          }).catch(err => {
            if (err.response) {
              err.response.data = transformKeys(
                err.response.data,
                caseFromServer
              );
            }
            throw err;
          }) as AxiosPromise;
        }

        return loadUrl(url, (url: string) => {
          if (!keysRef.current.has(url)) keysRef.current.add(url);
        });
      }
    );

    return api;
  }

  /**
   * @example
   *   await api.comments.post({}, { data: { body: '123' }})
   */
  const api = createProxy<AxiosPromise>(
    caseToServer,
    (
      method: Method,
      path: string,
      params: object,
      options: Partial<AxiosRequestConfig>
    ) => {
      const qs = transformKeys(queryString.stringify(params), caseToServer);

      const url = path + (qs ? `?${qs}` : '');

      return axios({
        ...options,
        data:
          'data' in options
            ? transformKeys(options.data, caseToServer)
            : undefined,
        method,
        url,
      }).catch(err => {
        if (err.response) {
          err.response.data = transformKeys(err.response.data, caseFromServer);
        }
        throw err;
      });
    }
  );

  function reset() {
    cache = new Map();
  }

  return { touch, useApi, api, reset };
}

export function useSuspend() {
  const forceUpdate = useForceUpdate();

  function suspend<T>(call: () => T, defaultValue?: T) {
    try {
      return { data: call(), loading: false };
    } catch (e) {
      if (!isPromise(e)) throw e;

      e.then(forceUpdate);

      return { data: defaultValue, loading: true };
    }
  }

  return suspend;
}
