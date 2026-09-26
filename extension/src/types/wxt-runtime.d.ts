import 'wxt/browser';
import 'webextension-polyfill';

declare module 'wxt/browser' {
  export interface WxtRuntime {
    getURL(path: string): string;
  }
}

declare module 'webextension-polyfill' {
  namespace Events {
    interface Event<T extends (...args: unknown[]) => unknown> {
      addListener(
        callback: (
          message: unknown,
          sender: Runtime.MessageSender,
          sendResponse: (response: unknown) => void
        ) => boolean | void | Promise<unknown>,
        ...params: unknown[]
      ): void;
    }
  }
}
