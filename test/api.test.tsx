import React, {
  FunctionComponent,
  useState,
  Dispatch,
  SetStateAction,
} from 'react';
import { render, cleanup, waitForElement } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import axios from 'axios';
import { act } from 'react-dom/test-utils';
import MockAdapter from 'axios-mock-adapter';

import { createApi, UrlBuilder, defer } from '../src';

const timers: { [id: number]: any } = {};
let timerKey = 0;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
function mockSetTimeout(innerFn: any, time: number) {
  function caller() {
    realClearTimeout(timeout);
    innerFn();
    delete timers[key];
  }

  const key = timerKey++;
  const timeout = realSetTimeout(caller, time);

  timers[key] = caller;

  return key;
}

function mockClearTimeout(id: number) {
  if (timers[id]) delete timers[id];
}

function advanceTimers() {
  for (let id in timers) {
    timers[id]();
  }
}

global.setTimeout = mockSetTimeout as typeof setTimeout;
global.clearTimeout = mockClearTimeout as typeof clearTimeout;

let mock = new MockAdapter(axios, { delayResponse: 1 });

// Example hateoas link binder
function bindLinks(object: any, loadUrl: (url: string) => unknown) {
  if (!object || typeof object !== 'object') return object;
  const { '@links': links } = object;
  if (!links) return object;

  const returned: any = Array.isArray(object) ? [] : {};

  for (let [key, value] of Object.entries(object)) {
    if (value && typeof value === 'object') {
      returned[key] = bindLinks(value, loadUrl);
    } else returned[key] = value;
  }

  if (!links) return returned;

  for (let [key, url] of Object.entries(links)) {
    if (!object[key]) {
      Object.defineProperty(returned, key, {
        get() {
          return loadUrl(url as string);
        },
        enumerable: false,
        configurable: false,
      });
    }
  }

  return returned;
}

function dedup(item: any): { [key: string]: any } {
  if (!item || typeof item !== 'object') return {};
  if (Array.isArray(item))
    return item.map(dedup).reduce((a, b) => ({ ...a, ...b }), {});

  const result: { [key: string]: any } = {};

  for (let value of Object.values(item)) {
    Object.assign(result, dedup(value));
  }

  if (item['@url']) {
    result[item['@url']] = item;
  }

  return result;
}

const {
  useApi,
  api,
  touch,
  touchWithMatcher,
  reset,
  preload,
  save,
  restore,
} = createApi(axios, {
  modifier: bindLinks,
  deduplicationStrategy: (item: any) => {
    const others = dedup(item);
    return others;
  },
  loadUrlFromCache: async url => {
    if (url === '/from_cache') {
      return { derp: 'derp' };
    }

    return undefined;
  },
});

function renderSuspending(fn: FunctionComponent) {
  const Component = fn;

  return render(
    <React.Suspense fallback={null}>
      <Component />
    </React.Suspense>
  );
}

beforeEach(() => {
  reset();
  mock.reset();
});

afterEach(cleanup);

it('works at all', async () => {
  mock.onGet('/users').reply(200, [{ id: 1, name: 'John Smith' }]);

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const users = api.users() as { id: number; name: string }[];

    return <div data-testid="element">{users.length}</div>;
  });

  const element = await waitForElement(() => queryByTestId('element'));

  expect(element!.textContent).toEqual('1');
});

it('works with explicit get', async () => {
  mock.onGet('/users').reply(200, [{ id: 1, name: 'John Smith' }]);

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const users = api.users.get() as { id: number; name: string }[];

    return <div data-testid="element">{users.length}</div>;
  });

  const element = await waitForElement(() => queryByTestId('element'));

  expect(element!.textContent).toEqual('1');
});

it('works with query params', async () => {
  mock
    .onGet('/values?some_prop=2')
    .reply(200, [{ some_value: 2 }, { some_value: 3 }]);

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const values = api.values({ someProp: 2 }) as { someValue: number }[];

    return <div data-testid="element">{values[0].someValue}</div>;
  });

  const element = await waitForElement(() => queryByTestId('element'));

  expect(element!.textContent).toEqual('2');
});

it('works with url params', async () => {
  const { useApi } = createApi(axios, {
    urlCase: 'kebab',
    modifier: bindLinks,
    deduplicationStrategy: (item: any) => {
      const others = dedup(item);
      return others;
    },
  });

  mock.onGet('/some-case-stuff/123').reply(200, { some_value: 123 });

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const value = api.someCaseStuff[123]() as { someValue: number };

    return <div data-testid="element">{value.someValue}</div>;
  });

  const element = await waitForElement(() => queryByTestId('element'));

  expect(element!.textContent).toEqual('123');
});

it('works with url params snake case', async () => {
  const { useApi } = createApi(axios, {
    modifier: bindLinks,
    deduplicationStrategy: (item: any) => {
      const others = dedup(item);
      return others;
    },
  });

  mock.onGet('/some_case_stuff/123').reply(200, { some_value: 123 });

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const value = api.someCaseStuff[123]() as { someValue: number };

    return <div data-testid="element">{value.someValue}</div>;
  });

  const element = await waitForElement(() => queryByTestId('element'));

  expect(element!.textContent).toEqual('123');
});

it('deduplicates requests', async () => {
  mock.onGet('/values/123').reply(200, { some_value: 123 });

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const value = api.values[123]() as { someValue: number };
    const value2 = api.values[123]() as { someValue: number };

    return <div data-testid="element">{value === value2 ? 'yes' : 'no'}</div>;
  });

  const element = await waitForElement(() => queryByTestId('element'));

  expect(element!.textContent).toEqual('yes');
});

it('deduplicates requests with defer', async () => {
  mock.onGet('/values/123').reply(200, { some_value: 123 });

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const { data: value } = defer(
      () => api.values[123]() as { someValue: number }
    );

    const value2 = api.values[123]() as { someValue: number };

    return <div data-testid="element">{value === value2 ? 'yes' : 'no'}</div>;
  });

  const element = await waitForElement(() => queryByTestId('element'));

  expect(element!.textContent).toEqual('yes');
});

it('works with defer', async () => {
  mock.onGet('/values/123').reply(200, { some_value: 123 });

  let wasLoading = false;

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const { data: value, loading } = defer(
      () => api.values[123]() as { someValue: number }
    );

    if (loading) {
      wasLoading = true;
      return null;
    }

    return <div data-testid="element">{value!.someValue}</div>;
  });

  const element = await waitForElement(() => queryByTestId('element'));

  expect(wasLoading).toBe(true);
  expect(element!.textContent).toEqual('123');

  expect(() => {
    defer(() => {
      throw new Error();
    });
  }).toThrow();
});

it('refetches when touch is called', async () => {
  let valueRef = { current: 1 };
  let rerenders = 0;
  let doError = true;
  let didError = null;
  mock.onGet('/val').reply(() => [200, { value: valueRef.current }]);
  mock.onGet('/null').reply(() => [404]);
  mock.onGet('/error').reply(() => {
    if (doError) {
      doError = false;
      return [500];
    }
    return [200];
  });

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const { value } = api.val.get() as { value: number };
    const nothing = api.null.get() as string | null;
    try {
      api.error.get();
      didError = false;
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      didError = true;
    }

    rerenders++;

    return (
      <div data-testid={`element-${value}`}>
        {value} {nothing === null ? 'null' : ''}
      </div>
    );
  });

  let element = await waitForElement(() =>
    queryByTestId(`element-${valueRef.current}`)
  );

  expect(element!.textContent).toEqual('1 null');
  valueRef.current = 2;

  expect(didError).toBe(true);

  await act(async () => {
    await touch('val', 'null', 'error');
  });

  element = await waitForElement(() =>
    queryByTestId(`element-${valueRef.current}`)
  );

  expect(element!.textContent).toEqual('2 null');
  expect(didError).toBe(false);

  await act(async () => {
    // make sure touching something else does not cause this to rerender
    await touch('something');
  });

  expect(rerenders).toBe(3);
});

it('refetches when touchWithMatcher is called', async () => {
  let valueRef = { current: 1 };
  let rerenders = 0;
  mock.onGet('/val').reply(() => [200, { value: valueRef.current }]);
  mock.onGet('/null').reply(() => [404]);

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const { value } = api.val.get() as { value: number };
    const nothing = api.null.get() as string | null;
    rerenders++;

    return (
      <div data-testid={`element-${value}`}>
        {value} {nothing === null ? 'null' : ''}
      </div>
    );
  });

  let element = await waitForElement(() =>
    queryByTestId(`element-${valueRef.current}`)
  );

  expect(element!.textContent).toEqual('1 null');
  valueRef.current = 2;

  await act(async () => {
    await touchWithMatcher((url: string, item: any) => {
      return url === '/null' || item; // make sure item is passed and is truthy
    });
  });

  element = await waitForElement(() =>
    queryByTestId(`element-${valueRef.current}`)
  );

  expect(element!.textContent).toEqual('2 null');

  await act(async () => {
    // make sure touching something else does not cause this to rerender
    await touch('something');
  });

  expect(rerenders).toBe(3);
});

it('removes unused', async () => {
  let suspenseCount = 0;
  mock.onGet('/val/1').reply(() => [200, { value: 1 }]);
  mock.onGet('/val/2').reply(() => [200, { value: 2 }]);

  let setIndex: Dispatch<SetStateAction<number>> = () => {};

  const { queryByTestId } = renderSuspending(() => {
    const [index, s] = useState(1);
    setIndex = s;

    const api = useApi();
    try {
      const { value } = api.val[index].get() as { value: number };

      return <div data-testid={`element-${value}`}>{value}</div>;
    } catch (e) {
      suspenseCount += 1;
      return null;
    }
  });

  // another component subscribing to a url
  renderSuspending(() => {
    const api = useApi();
    api.val[2]();
    return null;
  });

  advanceTimers();

  let element = await waitForElement(() => queryByTestId(`element-1`));

  expect(element!.textContent).toEqual('1');

  act(() => {
    setIndex(2);
  });

  advanceTimers();

  element = await waitForElement(() => queryByTestId(`element-2`));

  expect(element!.textContent).toEqual('2');

  act(() => {
    setIndex(1);
  });

  advanceTimers();

  element = await waitForElement(() => queryByTestId(`element-1`));

  expect(element!.textContent).toEqual('1');

  expect(suspenseCount).toBe(2);
});

it('supports wrapping axios in api without hook', async () => {
  mock.onPost('/val').reply(() => [200, { some_value: 'post!' }]);
  mock.onGet('/val?asdf=0').reply(() => [200, { value: 'get!' }]);
  const {
    data: { someValue },
  } = (await api.val.post({}, { data: { somethingCool: '123' } })) as {
    data: { someValue: string };
  };

  expect(someValue).toEqual('post!');
  expect(mock.history.post[0].data).toBe(
    JSON.stringify({ something_cool: '123' })
  );

  const {
    data: { value: value2 },
  } = (await api.val({ asdf: 0 })) as {
    data: { value: string };
  };

  expect(value2).toEqual('get!');
});

it('supports wrapping axios in api outside render phase', async () => {
  mock.onPost('/val').reply(() => [200, { value: 'post!' }]);
  mock.onGet('/val').reply(() => [200, { value: 'get!' }]);
  let api: null | UrlBuilder<unknown> = null;

  renderSuspending(() => {
    api = useApi();

    return null;
  });

  const {
    data: { value },
  } = (await api!.val.post({}, { data: { somethingCool: '123' } })) as {
    data: { value: string };
  };

  expect(value).toEqual('post!');
  expect(mock.history.post[0].data).toBe(
    JSON.stringify({ something_cool: '123' })
  );

  const {
    data: { value: value2 },
  } = (await api!.val()) as {
    data: { value: string };
  };

  expect(value2).toEqual('get!');
});

it('supports modifiers', async () => {
  mock
    .onGet('/val')
    .reply(() => [200, { name: 'count', '@links': { count: '/count' } }]);
  mock.onGet('/count').reply(() => [200, 1]);

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const val = api.val.get() as { name: string; count: number };
    const val2 = api.val.get() as { name: string; count: number };

    return (
      <div data-testid="element">
        {val.name}:{val.count}:{String(val === val2)}
      </div>
    );
  });

  let element = await waitForElement(() => queryByTestId(`element`));

  expect(element!.textContent).toEqual('count:1:true');
});

it('supports dependents', async () => {
  mock.onGet('/list').reply(() => [200, [{ val: 1, '@url': '/list/1' }]]);

  let setState: any;
  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const [doRequest, s] = useState(true);
    setState = s;

    if (doRequest) api.list() as { val: number }[];

    try {
      const { val } = doRequest
        ? (api.list[1]() as { val: number })
        : { val: 0 };

      return <div data-testid={`element-${val}`}>{val}</div>;
    } catch (e) {
      // this should not suspend
      throw new Error();
    }
  });

  let element = await waitForElement(() => queryByTestId(`element-1`));
  expect(element!.textContent).toEqual('1');

  act(() => {
    setState(false);
  });

  element = await waitForElement(() => queryByTestId(`element-0`));
  expect(element!.textContent).toEqual('0');
});

it('supports preloading', async () => {
  mock.onGet('/users').reply(() => [200, [{ id: 1, name: 'Billy' }]]);
  mock.onGet('/posts').reply(() => [200, [{ id: 2, body: 'post body' }]]);

  let users: any = null;
  let posts: any = null;

  let renders = 0;
  let api: UrlBuilder<unknown> | null = null;
  let promise: Promise<any> | null = null;
  renderSuspending(() => {
    renders++;
    api = useApi();

    promise = Promise.all([
      preload(() => {
        users = api!.users();
      }),
      preload(() => {
        posts = api!.posts();
      }),
    ]);

    return null;
  });

  expect(renders).toEqual(1);

  await promise;
  expect(users).toEqual([{ id: 1, name: 'Billy' }]);
  expect(posts).toEqual([{ id: 2, body: 'post body' }]);

  await act(async () => {
    await touch('users');
  });

  // make sure the component is not subscribed
  expect(renders).toEqual(1);

  let threw = false;
  try {
    await preload(() => {
      throw new Error();
    });
  } catch (_) {
    threw = true;
  }
  expect(threw).toBeTruthy();
});

it('supports preloading outside components', async () => {
  mock.onGet('/users').reply(() => [200, [{ id: 1, name: 'Billy' }]]);
  mock.onGet('/posts').reply(() => [200, [{ id: 2, body: 'post body' }]]);

  const promise = Promise.all([
    preload(() => {
      api!.users();
    }),
    preload(() => {
      api!.posts();
    }),
  ]);

  await promise;

  let renders = 0;
  let finished = false;
  renderSuspending(() => {
    renders++;
    const api = useApi();

    // these should not suspend because they are preloaded
    api!.users();
    api!.posts();

    finished = true;
    return null;
  });

  expect(renders).toEqual(1);
  expect(finished).toEqual(true);
});

it('works with 404 returning null', async () => {
  mock.onGet('/values/4').reply(404);

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const value = api.values[4]() as { someValue: number } | null;

    return (
      <div data-testid="element">{value === null ? 'null' : 'not null'}</div>
    );
  });

  let element = await waitForElement(() => queryByTestId('element'));
  expect(element!.textContent).toEqual('null');

  // is it null after a touch as well?
  touch('values');
  element = await waitForElement(() => queryByTestId('element'));

  expect(element!.textContent).toEqual('null');
});

it('works with server error throwing error', async () => {
  mock.onGet('/error').networkErrorOnce();

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    let errored = false;

    try {
      api.error.get();
    } catch (e) {
      if (typeof e.then === 'function') {
        throw e;
      }

      errored = true;
    }

    return (
      <div data-testid="element">{errored ? 'crash' : 'no crash Smee'}</div>
    );
  });

  const element = await waitForElement(() => queryByTestId('element'));

  expect(element!.textContent).toEqual('crash');
});

it('works with server error throwing error (non hook)', async () => {
  mock.onPost('/error').reply(500, { error_value: 0 });

  let err = null;
  try {
    await api.error.post();
  } catch (e) {
    err = e;
  }

  expect(err instanceof Error).toBe(true);
  expect(err.response.data).toEqual({ errorValue: 0 });
});

it('works with server error throwing error (outside hook)', async () => {
  mock.onPost('/error').reply(500, { error_value: 0 });

  let api: UrlBuilder<unknown> | null = null;
  renderSuspending(() => {
    api = useApi();

    return null;
  });

  let err = null;
  try {
    await api!.error.post();
  } catch (e) {
    err = e;
  }

  expect(err instanceof Error).toBe(true);
  expect(err.response.data).toEqual({ errorValue: 0 });
});

it('can save to a POJO', async () => {
  mock.onGet('/thing').reply(200, { value: 0 });

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    api.thing();
    return <div data-testid="element" />;
  });

  await waitForElement(() => queryByTestId('element'));

  expect(save()).toEqual({ '/thing': { value: 0 } });
});

it('can restore from a POJO', async () => {
  mock.onGet('/thing').reply(200, { value: 0 });
  restore({ '/thing': { value: 0 } });

  let renders = 0;
  const { queryByTestId } = renderSuspending(() => {
    renders++;
    const api = useApi();
    api.thing();
    return <div data-testid="element" />;
  });

  await waitForElement(() => queryByTestId('element'));

  // make sure the call did not suspend
  expect(renders).toBe(1);
});

it('can load from an external cache', async () => {
  let val = null;
  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    val = api.fromCache();
    return <div data-testid="element" />;
  });

  await waitForElement(() => queryByTestId('element'));

  expect(val).toEqual({ derp: 'derp' });
});
