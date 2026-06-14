/**
 * mock_globals.ts - Establishes mock global browser APIs for the extension test environment.
 * Must be imported first to ensure the mocks are set up before other modules load.
 */

// Mock React
(globalThis as any).React = {
  useState: (init: any) => {
    let state = init;
    const setter = (newVal: any) => {
      state = typeof newVal === 'function' ? newVal(state) : newVal;
    };
    return [state, setter];
  },
  useEffect: (cb: any, deps: any) => {
    const cleanup = cb();
    if (cleanup && typeof cleanup === 'function') {
      (globalThis as any)._effectCleanup = cleanup;
    }
  },
  createElement: () => ({})
};

// Mock ReactDOM
(globalThis as any).createRoot = () => ({
  render: () => {},
  unmount: () => {}
});

const mockPostMessageListeners: Function[] = [];
const mockChromeMessageListeners: Function[] = [];
const mockStorageChangeListeners: Function[] = [];

// Storage internal cache
const mockStorageCache: { [key: string]: any } = {
  geminiApiKey: 'TEST_GEMINI_KEY',
  displayMode: 'bilingual'
};

// Global alert mock to prevent ReferenceError
(globalThis as any).alert = (msg: any) => {
  console.log('[Mock Alert] Message:', msg);
};

(globalThis as any).window = {
  fetch: async (input: any, init: any) => {
    return {
      ok: true,
      clone: () => ({
        arrayBuffer: async () => new ArrayBuffer(16) // Mock 16-byte media segment
      })
    } as any;
  },
  addEventListener: (event: string, cb: Function) => {
    if (event === 'message') {
      mockPostMessageListeners.push(cb);
    }
  },
  postMessage: (data: any, targetOrigin: string, transfer?: any[]) => {
    console.log('[Mock Window] postMessage received:', data.type, 'url:', data.url);
    setTimeout(() => {
      mockPostMessageListeners.forEach(cb => {
        cb({
          source: (globalThis as any).window,
          data: data
        });
      });
    }, 0);
  },
  location: {
    pathname: '/'
  },
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  getComputedStyle: (el: any) => {
    console.log('[Mock Window] getComputedStyle called for element');
    return {
      position: 'static',
      getPropertyValue: (prop: string) => ''
    };
  },
  alert: (msg: any) => {
    console.log('[Mock Window Alert] Message:', msg);
  }
};

let mockVideoElement: any = null;
const mockElementsCache = new Map<string, any>();

(globalThis as any)._setMockVideo = (hasVideo: boolean) => {
  if (hasVideo) {
    mockVideoElement = {
      paused: false,
      getBoundingClientRect: () => ({
        width: 1280,
        height: 720
      }),
      parentElement: {
        style: {},
        getAttribute: () => null,
        parentElement: null,
        querySelector: (query: string) => {
          return mockElementsCache.get(query) || null;
        },
        appendChild: (child: any) => {
          console.log('[Mock DOM] Appended child to video parent');
        },
        attachShadow: (options: any) => {
          console.log('[Mock DOM] Attached shadow root to video parent');
          const shadowRoot = {
            appendChild: (child: any) => {
              console.log('[Mock Shadow DOM] Appended child to video parent shadow root');
            },
            querySelector: (query: string) => {
              return mockElementsCache.get(query) || null;
            }
          };
          return shadowRoot;
        }
      },
      captureStream: () => {
        return new (globalThis as any).MediaStream();
      }
    };
  } else {
    mockVideoElement = null;
  }
};

(globalThis as any).document = {
  createElement: (tag: string) => {
    console.log(`[Mock Document] createElement: <${tag}>`);
    const el: any = {
      id: '',
      className: '',
      innerText: '',
      style: {},
      textContent: '',
      remove: () => {
        console.log(`[Mock DOM] Element removed: <${tag}>`);
        if (el.id) mockElementsCache.delete(`#${el.id}`);
        if (el.className) mockElementsCache.delete(`.${el.className}`);
      },
      appendChild: (child: any) => {
        console.log(`[Mock DOM] Appended child to <${tag}>`);
      },
      querySelector: (query: string) => {
        return mockElementsCache.get(query) || null;
      },
      attachShadow: (options: any) => {
        console.log(`[Mock DOM] Attached shadow root to <${tag}>`);
        const shadowRoot = {
          appendChild: (child: any) => {
            console.log('[Mock Shadow DOM] Appended child to shadow root');
          },
          querySelector: (query: string) => {
            return mockElementsCache.get(query) || null;
          }
        };
        el.shadowRoot = shadowRoot;
        return shadowRoot;
      }
    };
    
    // Use Proxy to dynamically register ID and ClassName in selector lookup cache
    const proxy = new Proxy(el, {
      set(target, prop, value) {
        target[prop] = value;
        if (prop === 'id' && value) {
          mockElementsCache.set(`#${value}`, proxy);
        }
        if (prop === 'className' && value) {
          mockElementsCache.set(`.${value}`, proxy);
        }
        return true;
      }
    });

    return proxy;
  },
  querySelector: (query: string) => {
    if (query === 'video') return mockVideoElement;
    return mockElementsCache.get(query) || null;
  },
  querySelectorAll: (query: string) => {
    if (query === 'video' && mockVideoElement) return [mockVideoElement];
    return [];
  },
  head: {
    appendChild: (el: any) => {
      console.log('[Mock Document] Appended element to head');
      if (el && el.textContent) {
        console.log('[Mock Document] Evaluating injected script content...');
        try {
          new Function(el.textContent)();
        } catch (err) {
          console.error('[Mock Document] Injected script execution failed:', err);
        }
      }
    }
  },
  documentElement: {
    appendChild: (el: any) => {
      console.log('[Mock Document] Appended element to documentElement');
      if (el && el.textContent) {
        console.log('[Mock Document] Evaluating injected script content...');
        try {
          new Function(el.textContent)();
        } catch (err) {
          console.error('[Mock Document] Injected script execution failed:', err);
        }
      }
    }
  }
};

(globalThis as any).chrome = {
  storage: {
    local: {
      get: (keys: any, cb?: (res: any) => void) => {
        const result: any = {};
        if (typeof keys === 'string') {
          result[keys] = mockStorageCache[keys];
        } else if (Array.isArray(keys)) {
          keys.forEach(k => {
            result[k] = mockStorageCache[k];
          });
        } else if (typeof keys === 'object') {
          Object.keys(keys).forEach(k => {
            result[k] = mockStorageCache[k] !== undefined ? mockStorageCache[k] : keys[k];
          });
        }
        if (cb) {
          setTimeout(() => cb(result), 0);
        } else {
          return Promise.resolve(result);
        }
      },
      set: (data: any, cb?: () => void) => {
        const changes: { [key: string]: chrome.storage.StorageChange } = {};
        Object.keys(data).forEach(k => {
          const oldValue = mockStorageCache[k];
          const newValue = data[k];
          mockStorageCache[k] = newValue;
          if (oldValue !== newValue) {
            changes[k] = { oldValue, newValue };
          }
        });
        
        // Trigger onChanged listener if any changes occurred
        if (Object.keys(changes).length > 0) {
          console.log('[Mock Storage] storage.local.set triggered changes:', JSON.stringify(changes, null, 2));
          setTimeout(() => {
            mockStorageChangeListeners.forEach(listener => {
              listener(changes, 'local');
            });
          }, 0);
        }
        
        if (cb) {
          setTimeout(cb, 0);
          return;
        } else {
          return Promise.resolve();
        }
      }
    },
    onChanged: {
      addListener: (cb: Function) => {
        mockStorageChangeListeners.push(cb);
      },
      removeListener: (cb: Function) => {
        const idx = mockStorageChangeListeners.indexOf(cb);
        if (idx !== -1) {
          mockStorageChangeListeners.splice(idx, 1);
        }
      }
    }
  },
  runtime: {
    id: 'mock-extension-id',
    openOptionsPage: async () => {},
    getURL: (path: string) => `chrome-extension://mock-extension-id/${path}`,
    sendMessage: (msg: any) => {
      console.log('[Mock Chrome Extension] runtime.sendMessage dispatched:', JSON.stringify(msg, null, 2));
      return new Promise((resolve) => {
        let resolved = false;
        const sendResponse = (response: any) => {
          if (!resolved) {
            resolved = true;
            resolve(response);
          }
        };
        setTimeout(() => {
          mockChromeMessageListeners.forEach(cb => {
            cb(msg, { tab: { id: 999 }, frameId: 0 }, sendResponse);
          });
          if (!resolved && msg.action === 'ABORT_TRANSLATION') {
            resolve(undefined);
          }
        }, 0);
      });
    },
    onMessage: {
      addListener: (cb: Function) => {
        mockChromeMessageListeners.push(cb);
      },
      removeListener: (cb: Function) => {
        const idx = mockChromeMessageListeners.indexOf(cb);
        if (idx !== -1) {
          mockChromeMessageListeners.splice(idx, 1);
        }
      }
    }
  },
  permissions: {
    contains: async () => true,
    request: async () => true
  },
  tabs: {
    query: async (queryInfo: any) => {
      return [{ id: 999, active: true, currentWindow: true }];
    },
    sendMessage: async (tabId: number, message: any, options?: any) => {
      console.log(`[Mock Chrome Extension] tabs.sendMessage dispatched to Tab ${tabId}:`, JSON.stringify(message, null, 2));
      setTimeout(() => {
        mockChromeMessageListeners.forEach(cb => {
          cb(message, {}, () => {});
        });
      }, 0);
    }
  }
};

(globalThis as any).Blob = class MockBlob {
  constructor(public parts: any[], public options?: any) {}
  get size() { return 100; }
  get type() { return this.options?.type || 'audio/webm'; }
};

(globalThis as any).FileReader = class MockFileReader {
  public result: string = 'data:audio/webm;base64,U2xpZGluZ1dpbmRvdy1Nb2NrLUJhc2U2NA==';
  public onloadend: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  
  readAsDataURL(blob: any) {
    setTimeout(() => {
      if (this.onloadend) this.onloadend();
    }, 5);
  }
};

(globalThis as any).MediaRecorder = class MockMediaRecorder {
  public state: string = 'inactive';
  public mimeType: string;
  public ondataavailable: ((event: any) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onstop: (() => void) | null = null;

  static isTypeSupported(type: string) {
    return type === 'audio/webm;codecs=opus';
  }

  constructor(public stream: any, public options: any) {
    this.mimeType = options?.mimeType || 'audio/webm';
  }

  start(timeslice?: number) {
    this.state = 'recording';
    console.log(`[Mock MediaRecorder] Recording started with timeslice=${timeslice}ms`);
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({
        data: new (globalThis as any).Blob(
          [new ArrayBuffer(10)],
          { type: this.mimeType }
        )
      });
    }
    console.log('[Mock MediaRecorder] Recording stopped.');
    if (this.onstop) {
      this.onstop();
    }
  }
};

(globalThis as any).MediaStream = class MockMediaStream {
  getAudioTracks() {
    return [{ id: 'audio-track-mock', kind: 'audio', enabled: true }];
  }
};
