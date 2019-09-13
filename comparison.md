# Why not just a useEffect hook or Redux?

Because less code is much easier to maintain and test. Compare `useApi` to the a Redux implementation and a hook based implementation:

_Redux:_

```js
// redux & redux-thunk style data loading:

const users = {
  getById(id) {
    return axios.get(`/users/${id}`);
  },
  // query, update, delete, etc.
};

// then write actions
const getUserById = id => async dispatch => {
  dispatch({ type: 'LOADING_USER', id });
  try {
    dispatch({
      type: 'LOAD_USER_SUCCESS',
      id,
      user: await users.getById(id),
    });
  } catch (e) {
    dispatch({
      type: 'LOAD_USER_FAILURE',
      id,
      error: e,
    });
  }
};

// then write a reducer
const initialState = {};

function userReducer(state = initialState, { type, ...payload }) {
  switch (type) {
    case 'LOADING_USER':
      if (state[payload.id] && state[payload.id].loading) return state;
      return {
        ...state,
        [payload.id]: { loading: true, error: undefined, value: undefined },
      };
    case 'LOAD_USER_SUCCESS':
      return {
        ...state,
        [payload.id]: { loading: false, error: undefined, value: payload.user },
      };
    case 'LOAD_USER_FAILURE':
      return {
        ...state,
        [payload.id]: { loading: false, error: payload.error },
      };
    default:
      return state;
  }
}

// then write a Hook
function useUser(id) {
  const user = useSelector(state => state.users[id]);
  const dispatch = useDispatch();

  useEffect(() => {
    if (!user) dispatch(getUserById(id));
  });

  if (user === undefined)
    return { loading: true, error: undefined, value: undefined };

  return user;
}
```

Some things to think about:

- Would need to write actions and reducers for every collection or data type
- How do you re-fetch?
- How do you garbage collect old requests?
- How do you run this conditionally?
- Does not suspend

Similar boilerplate exists for a hook based solution, but is still much smaller than the Redux version:

```js
// a simple reducer to handle our three actions
function reducer(state, { type, ...payload }) {
  switch (type) {
    case 'LOADING':
      return { loading: true, error: undefined, data: undefined };
    case 'SUCCESS':
      return { loading: false, error: undefined, data: payload.data };
    case 'FAILURE':
      return { loading: false, error: payload.error };
    default:
      return state;
  }
}

// a custom hook to make data loading easier
function usePromise(asyncFunction, deps) {
  const [state, dispatch] = useReducer(reducer, {
    loading: { loading: true, error: undefined, data: undefined },
  });

  useEffect(() => {
    let isCurrent = true;

    dispatch({
      type: 'LOADING',
    });

    asyncFunction()
      .then(data => {
        if (isCurrent)
          dispatch({
            type: 'SUCCESS',
            data,
          });
      })
      .catch(error => {
        if (isCurrent)
          dispatch({
            type: 'FAILURE',
            error,
          });
      });

    return () => {
      isCurrent = false;
    };
  }, deps);

  return state;
}

// usage is pretty simple
function Component({ id }) {
  const { loading, data: user } = usePromise(async () => {
    return (await axios.get(`/users/${id}`)).data;
  }, [id]);

  if (loading) return <Loader />;

  // more component code
}
```

Some things to think about:

- How do you re-fetch?
- How do you de-duplicate requests?
- How do you run this conditionally?
- Still lots of code
- Does not suspend

Compare this to the `useApi` version:

```js
import { createApi } from '@synvox/api';
import axios from 'axios';

const { useApi, touch } = createApi(axios);

// in a component
function Component({ id }) {
  const api = useApi();
  const user = api.users[id].get();

  // do something with user
}
```
