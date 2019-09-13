import React, {
  FunctionComponent,
  useState,
  Dispatch,
  SetStateAction,
} from 'react';
import { render, cleanup, waitForElement } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { createApi, UrlBuilder, useSuspend } from '../src';
import { act } from 'react-dom/test-utils';

let mock = new MockAdapter(axios, { delayResponse: 1 });

const { useApi, api, touch, reset } = createApi(axios);

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
  mock.onGet('/values/123').reply(200, { some_value: 123 });

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const value = api.values[123]() as { someValue: number };

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

it('works with useSuspend', async () => {
  mock.onGet('/values/123').reply(200, { some_value: 123 });

  let wasLoading = false;

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const suspend = useSuspend();
    const { data: value, loading } = suspend(
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
});

it('refetches when touch is called', async () => {
  let valueRef = { current: 1 };
  let rerenders = 0;
  mock.onGet('/val').reply(() => [200, { value: valueRef.current }]);

  const { queryByTestId } = renderSuspending(() => {
    const api = useApi();
    const { value } = api.val.get() as { value: number };
    rerenders++;

    return <div data-testid={`element-${value}`}>{value}</div>;
  });

  let element = await waitForElement(() =>
    queryByTestId(`element-${valueRef.current}`)
  );

  expect(element!.textContent).toEqual('1');
  valueRef.current = 2;

  await act(async () => {
    await touch('val');
  });

  element = await waitForElement(() =>
    queryByTestId(`element-${valueRef.current}`)
  );

  expect(element!.textContent).toEqual('2');

  await act(async () => {
    // make sure touching something else does not cause this to rerender
    await touch('something');
  });

  expect(rerenders).toBe(2);
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

  let element = await waitForElement(() => queryByTestId(`element-1`));

  expect(element!.textContent).toEqual('1');

  act(() => {
    setIndex(2);
  });

  element = await waitForElement(() => queryByTestId(`element-2`));

  expect(element!.textContent).toEqual('2');

  act(() => {
    setIndex(1);
  });

  element = await waitForElement(() => queryByTestId(`element-1`));

  expect(element!.textContent).toEqual('1');

  expect(suspenseCount).toBe(3);
});

it('supports wrapping axios in api without hook', async () => {
  mock.onPost('/val').reply(() => [200, { value: 'post!' }]);
  mock.onGet('/val?asdf=0').reply(() => [200, { value: 'get!' }]);
  const {
    data: { value },
  } = (await api.val.post({}, { data: { somethingCool: '123' } })) as {
    data: { value: string };
  };

  expect(value).toEqual('post!');
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
