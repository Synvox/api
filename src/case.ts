// @TODO move this to a module

export type CaseMethod = null | ((word: string, index: number) => string);

export const caseMethods: {
  [id: string]: CaseMethod;
} = {
  none: null,
  camel(word, index) {
    return index === 0 ? word : word[0].toUpperCase() + word.slice(1);
  },
  snake(word, index) {
    return index === 0 ? word : '_' + word;
  },
  kebab(word, index) {
    return index === 0 ? word : '-' + word;
  },
  constant(word, index) {
    return index === 0 ? word.toUpperCase() : '_' + word.toUpperCase();
  },
  pascal(word, _index) {
    return word[0].toUpperCase() + word.slice(1);
  },
};

export function transformKey(key: string, method: CaseMethod) {
  if (method === null) return key;
  return key
    .replace(/_/g, ' ')
    .replace(/(\b|^|[a-z])([A-Z])/g, '$1 $2')
    .replace(/ +/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .reduce(
      (str, word, index) => str + method(word, index),
      key.startsWith('_') ? '_' : ''
    );
}

export function transformKeys(obj: any, method: CaseMethod): any {
  if (method === null) return obj;
  if (typeof obj !== 'object') return obj;
  if (!obj) return obj;
  if (Array.isArray(obj)) return obj.map(item => transformKeys(item, method));

  return Object.keys(obj)
    .map(key => ({ key, value: transformKeys(obj[key], method) }))
    .map(({ key, value }) => ({
      value,
      key: transformKey(key, method),
    }))
    .reduce(
      (returned, { key, value }) => Object.assign(returned, { [key]: value }),
      {}
    );
}
