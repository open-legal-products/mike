import {getRequestConfig} from 'next-intl/server';

export default getRequestConfig(async () => {
  return {
    locale: 'en',
    messages: (await import('../../messages/en.json')).default
  };
});
