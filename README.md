# `@synvox/api`

![Travis (.org)](https://img.shields.io/travis/synvox/api)
![Codecov](https://img.shields.io/codecov/c/github/synvox/api)
![Bundle Size](https://badgen.net/bundlephobia/minzip/@synvox/api)
![License](https://badgen.net/npm/license/@synvox/api)
[![Language grade: JavaScript](https://img.shields.io/lgtm/grade/javascript/g/Synvox/api.svg?logo=lgtm&logoWidth=18)](https://lgtm.com/projects/g/Synvox/api/context:javascript)

Simple request handling in React using Suspense.

```
npm i @synvox/api axios
```

## CodeSandbox

[![Open on CodeSandbox](https://codesandbox.io/static/img/play-codesandbox.svg)](https://codesandbox.io/s/stupefied-easley-l9djw?fontsize=14)

## Features

- Wrapper around `axios`. Pass in an `axios` instance of your choosing
- Small interface
  - `useApi` a suspense compatible hook for loading data
  - `api` a wrapper around axios
  - `touch(...keys: string[])` to refetch queries
- Run any `GET` request through Suspense
- Refresh requests without flickering
- De-duplicates `GET` requests to the same url
- Caches urls while they're in use and garbage collects them when they are not.
- Can be used in conditions and loops
- Easy integration with websockets and SSE for real-time apps
- Well tested and and written in Typescript
- Tiny

## Basic Example

```js
import { createApi } from '@synvox/api';
import axios from 'axios';

const { useApi } = createApi(
  axios.create({
    baseURL: 'https://your-api.com',
    headers: {
      'Authorization': 'Bearer your-token-here'
    }
  })
);

export useApi;

// then elsewhere:

import { useApi } from './api'

function Post({postId}) {
  const api = useApi();

  const user = api.users.me.get(); // GET https://your-api.com/users/me
  const post = api.posts[postId].get(); // GET https://your-api.com/posts/{postId}
  const comments = api.comments.get({postId: post.id}); // GET https://your-api.com/comments?post_id={postId}

  const authorName = post.authorId === user.id
    ? 'You'
    : api.users[post.authorId].get().name// GET https://your-api.com/users/{post.authorId}

  return <>
    <h2>{post.title} by {authorName}</h2>
    <p>{post.body}</p>
    <ul>
      {comments.map(comment=><li key={comment.id}>{comment.body}</li>)}
    </ul>
  </>;
}

```

## The `useApi` hook

`useApi` returns a `Proxy` that builds an axios request when you call it. For example:

```js
import { createApi } from '@synvox/api';
import axios from 'axios';

const { useApi } = createApi(axios);

// in a component:
const api = useApi();

const users = api.users(); // calls GET /users
const notifications = api.notifications.get(); // calls GET /notifications, defaults to `get` when no method is specified.

const userId = 1;
const comments = api.users({ userId: 1 }); // calls GET /users?user_id=1

const projectId = 2;
const project = api.projects[projectId](); // calls GET /projects/2

const userProject = api.users[userId].projects[projectId]({ active: true }); // calls GET /users/1/projects/2?active=true
```

### Calling `api`

```ts
api.path[urlParam](params: object, config?: AxiosConfig) as Type
//  |    |         |               |__ axios options like `data` and `headers`
//  |    |         |__ query params (uses query-string under the hood so arrays work)
//  |    |__ url params
//  \__ the url path
```

### `useApi` and the laws of hooks

You cannot wrap a hook in a condition or use it in a loop, but the `api` object is not a hook, so feel free to use it wherever data is needed.

```js
const api = useApi();

const users = shouldLoadUsers ? api.users() : [];

return (
  <>
    {users.map(user => (
      <div key={user.id}>
        {user.name}: {api.stars.count({ userId: user.id })}
      </div>
    ))}
  </>
);
```

### Refetching

Call `touch` to refetch queries by url fragment(s).

```js
import { createApi } from '@synvox/api';
import axios from 'axios';

const { useApi, touch } = createApi(axios);

// in a component
const api = useApi();
const [commentBody, setCommentBody] = useState('');

async function submit(e) {
  e.preventDefault();

  // notice you can specify a method when making a call
  await api.comments.post(
    {},
    {
      data: {
        body: commentBody,
      },
    }
  );
  // when used outside a render phase, api returns an AxiosPromise

  await touch('comments', 'users');

  setCommentBody('');
}

return <form onSubmit={submit}>// Component stuff</form>;
```

The `touch` function will find all the used requests that contain the word(s) given to touch and run those requests again in the background, only updating the components when all the requests are completed. This helps a ton with flickering and race conditions.

Because `touch` is not a hook, it can be used outside a component in a websocket handler or a SSE listener to create real-time experiences.

```js
import { touch } from './api';

const sse = new EventSource('/events');

sse.addEventListener('update', e => {
  // assume e.data is {touches: ['messages', 'notifications']}
  touch(...e.data.touches);
});
```

## Using `api` outside a component

When the api object is used outside a component as its rendering, it will return an `axios` call to that url.

```js
import { api } from './api';

export async function logout() {
  // notice you can specify a method like `post` when making a call
  await api.logout.post();
}
```

## Not Suspending

If you'd rather not use the suspense boundary for whatever reason, then use `useSuspend` which returns a `suspend` function:

```js
const api = useApi();
const suspend = useSuspend();

const { data: users, loading } = suspend(() => api.users(), []);
```

This still subscribes the component to updates from `touch`, request de-duplication, and garbage collection.

## Binding Links

You can build graph-like structures with `useApi` by adding a modifier. Pass in a `modifier` to `createApi` to build custom link bindings:

```js
// Transforms responses like {'@links': {comments: '/comments?post_id=123' }} into
// an object where data.comments will load /comments?post_id=123

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

const { useApi } = createApi(axios, {
  modifier: bindLinks,
});
```

## Defining nested dependencies

Say you call `/comments` which returns `Comment[]` and want each `Comment` to be loaded into the cache individually so calling `/comments/:id` doesn't make another request. You can do this by setting a deduplication strategy.

```js
// will update the cache for all all `{"@url": ...} objects
function deduplicationStrategy(item: any): { [key: string]: any } {
  if (!item || typeof item !== 'object') return {};
  if (Array.isArray(item))
    return item
      .map(deduplicationStrategy)
      .reduce((a, b) => ({ ...a, ...b }), {});

  const result: { [key: string]: any } = {};

  for (let value of Object.values(item)) {
    Object.assign(result, deduplicationStrategy(value));
  }

  if (item['@url']) {
    result[item['@url']] = item;
  }

  return result;
}

const { useApi, api, touch, reset } = createApi(axios, {
  modifier: bindLinks,
  deduplicationStrategy: (item: any) => {
    const others = deduplicationStrategy(item);
    return others;
  },
});
```

## Case Transformations

By default `createApi` will `snake_case` urls, params, and json bodies in a request and `camelCase` json bodies in responses.

This can be customized by passing a second parameter to `createApi`

```js
createApi(axios, {
  requestCase: 'snake' | 'camel' | 'constant' | 'pascal' | 'none',
  responseCase: 'snake' | 'camel' | 'constant' | 'pascal' | 'none',
});
```

## Why not just a `useEffect` hook or Redux?

[See Comparison](comparison.md)

### Obligatory Notice about Suspense for data loading

The React team has asked that we do not build on `react-cache` until it is stable, but that doesn't mean we can't experiment with an implementation of our own Suspense compatible cache until `react-cache` is stable.
