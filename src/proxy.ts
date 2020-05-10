import { Method, AxiosRequestConfig, AxiosPromise } from 'axios';
import { transformKey, CaseMethod } from './case';
import { UrlBuilder } from '.';

type Callback<ReturnType> = (
  method: Method,
  path: string,
  params: object,
  options: Partial<AxiosRequestConfig>
) => ReturnType | AxiosPromise<ReturnType>;

function createProxy<ReturnType>(
  caseForUrls: CaseMethod,
  callback: Callback<ReturnType>,
  path: string[] = ['']
): UrlBuilder<ReturnType> {
  const callable = (
    params: object = {},
    options: Partial<AxiosRequestConfig> = {}
  ) => {
    let method = path[path.length - 1];
    const hasMethod = ['post', 'get', 'put', 'patch', 'delete'].includes(
      method
    );

    let urlBase = '';
    if (!hasMethod) {
      method = 'get';
      urlBase = path.join('/');
    } else urlBase = path.slice(0, -1).join('/');

    return callback(method as Method, urlBase, params, options);
  };

  const proxy = new Proxy(callable, {
    get: (_, prop) => {
      return createProxy<ReturnType>(caseForUrls, callback, [
        ...path,
        transformKey(String(prop), caseForUrls),
      ]);
    },
  });

  return proxy as UrlBuilder<ReturnType>;
}

export default createProxy;
