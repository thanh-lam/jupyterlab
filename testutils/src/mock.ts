// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import 'jest';

import { ISessionContext, SessionContext } from '@jupyterlab/apputils';

import {
  Kernel,
  KernelMessage,
  KernelSpec,
  Session,
  ServiceManager,
  Contents,
  ServerConnection
} from '@jupyterlab/services';

import { ArrayIterator } from '@lumino/algorithm';

import { AttachedProperty } from '@lumino/properties';

import { UUID } from '@lumino/coreutils';

import { Signal } from '@lumino/signaling';

import { PathExt } from '@jupyterlab/coreutils';

export const KERNELSPECS: KernelSpec.ISpecModel[] = [
  {
    argv: [
      '/Users/someuser/miniconda3/envs/jupyterlab/bin/python',
      '-m',
      'ipykernel_launcher',
      '-f',
      '{connection_file}'
    ],
    display_name: 'Python 3',
    language: 'python',
    metadata: {},
    name: 'python3',
    resources: {}
  },
  {
    argv: [
      '/Users/someuser/miniconda3/envs/jupyterlab/bin/python',
      '-m',
      'ipykernel_launcher',
      '-f',
      '{connection_file}'
    ],
    display_name: 'R',
    language: 'python',
    metadata: {},
    name: 'irkernel',
    resources: {}
  }
];

export const KERNEL_MODELS: Kernel.IModel[] = [
  {
    name: 'python3',
    id: UUID.uuid4()
  },
  {
    name: 'r',
    id: UUID.uuid4()
  },
  {
    name: 'python3',
    id: UUID.uuid4()
  }
];

// Notebook Paths for certain kernel name
export const NOTEBOOK_PATHS: { [kernelName: string]: string[] } = {
  python3: ['Untitled.ipynb', 'Untitled1.ipynb', 'Untitled2.ipynb'],
  r: ['Visualization.ipynb', 'Analysis.ipynb', 'Conclusion.ipynb']
};

/**
 * Forceably change the status of a session context.
 * An iopub message is emitted for the change.
 *
 * @param sessionContext The session context of interest.
 * @param newStatus The new kernel status.
 */
export function updateKernelStatus(
  sessionContext: ISessionContext,
  newStatus: KernelMessage.Status
) {
  const kernel = sessionContext.session!.kernel!;
  (kernel as any).status = newStatus;
  (sessionContext.statusChanged as any).emit(newStatus);
  const msg = KernelMessage.createMessage({
    session: kernel.clientId,
    channel: 'iopub',
    msgType: 'status',
    content: { execution_state: newStatus }
  });
  emitIopubMessage(sessionContext, msg);
}

/**
 * Emit an iopub message on a session context.
 *
 * @param sessionContext The session context
 * @param msg Message created with `KernelMessage.createMessage`
 */
export function emitIopubMessage(
  context: ISessionContext,
  msg: KernelMessage.IIOPubMessage
): void {
  const kernel = context!.session!.kernel!;
  const msgId = Private.lastMessageProperty.get(kernel);
  (msg.parent_header as any).session = kernel.clientId;
  (msg.parent_header as any).msg_id = msgId;
  (kernel.iopubMessage as any).emit(msg);
}

/**
 * Create a session context given a partial session model.
 *
 * @param model The session model to use.
 */
export function createSimpleSessionContext(
  model: Private.RecursivePartial<Session.IModel> = {}
): ISessionContext {
  const kernel = new KernelMock({ model: model?.kernel || {} });
  const session = new SessionConnectionMock({ model }, kernel);
  return new SessionContextMock({}, session);
}

/**
 * Clone a kernel connection.
 */
export function cloneKernel(
  kernel: Kernel.IKernelConnection
): Kernel.IKernelConnection {
  return (kernel as any).clone();
}

/**
 * A mock kernel object.
 *
 * @param model The model of the kernel
 */
export const KernelMock = jest.fn<
  Kernel.IKernelConnection,
  [Private.RecursivePartial<Kernel.IKernelConnection.IOptions>]
>(options => {
  const model = options.model || {};
  if (!model.id) {
    (model! as any).id = 'foo';
  }
  if (!model.name) {
    (model! as any).name = KERNEL_MODELS[0].name;
  }
  options = {
    clientId: UUID.uuid4(),
    username: UUID.uuid4(),
    ...options,
    model
  };
  let executionCount = 0;
  const spec = Private.kernelSpecForKernelName(model!.name!)!;
  const thisObject: Kernel.IKernelConnection = {
    ...jest.requireActual('@jupyterlab/services'),
    ...options,
    ...model,
    status: 'idle',
    spec: () => {
      return Promise.resolve(spec);
    },
    dispose: jest.fn(),
    clone: jest.fn(() => {
      const newKernel = Private.cloneKernel(options);
      newKernel.iopubMessage.connect((_, args) => {
        iopubMessageSignal.emit(args);
      });
      newKernel.statusChanged.connect((_, args) => {
        (thisObject as any).status = args;
        statusChangedSignal.emit(args);
      });
      return newKernel;
    }),
    info: jest.fn(Promise.resolve),
    shutdown: jest.fn(Promise.resolve),
    requestHistory: jest.fn(() => {
      const historyReply = KernelMessage.createMessage({
        channel: 'shell',
        msgType: 'history_reply',
        session: options.clientId!,
        username: options.username!,
        content: {
          history: [],
          status: 'ok'
        }
      });
      return Promise.resolve(historyReply);
    }),
    requestExecute: jest.fn(options => {
      const msgId = UUID.uuid4();
      executionCount++;
      Private.lastMessageProperty.set(thisObject, msgId);
      const msg = KernelMessage.createMessage({
        channel: 'iopub',
        msgType: 'execute_input',
        session: thisObject.clientId,
        username: thisObject.username,
        msgId,
        content: {
          code: options.code,
          execution_count: executionCount
        }
      });
      iopubMessageSignal.emit(msg);
      return new MockShellFuture();
    })
  };
  // Add signals.
  const iopubMessageSignal = new Signal<
    Kernel.IKernelConnection,
    KernelMessage.IIOPubMessage
  >(thisObject);
  const statusChangedSignal = new Signal<
    Kernel.IKernelConnection,
    Kernel.Status
  >(thisObject);
  (thisObject as any).statusChanged = statusChangedSignal;
  (thisObject as any).iopubMessage = iopubMessageSignal;
  return thisObject;
});

/**
 * A mock session connection.
 *
 * @param options Addition session options to use
 * @param model A session model to use
 */
export const SessionConnectionMock = jest.fn<
  Session.ISessionConnection,
  [
    Private.RecursivePartial<Session.ISessionConnection.IOptions>,
    Kernel.IKernelConnection | null
  ]
>((options, kernel) => {
  const name = kernel?.name || options.model?.name || KERNEL_MODELS[0].name;
  kernel = kernel || new KernelMock({ model: { name } });
  const model = {
    path: 'foo',
    type: 'notebook',
    name: 'foo',
    ...options.model,
    kernel: kernel!.model
  };
  const thisObject: Session.ISessionConnection = {
    ...jest.requireActual('@jupyterlab/services'),
    id: UUID.uuid4(),
    ...options,
    model,
    ...model,
    kernel,
    dispose: jest.fn(),
    changeKernel: jest.fn(partialModel => {
      return Private.changeKernel(kernel!, partialModel!);
    }),
    selectKernel: jest.fn(),
    shutdown: jest.fn(() => Promise.resolve(void 0))
  };
  const disposedSignal = new Signal<Session.ISessionConnection, undefined>(
    thisObject
  );
  const propertyChangedSignal = new Signal<
    Session.ISessionConnection,
    'path' | 'name' | 'type'
  >(thisObject);
  const statusChangedSignal = new Signal<
    Session.ISessionConnection,
    Kernel.Status
  >(thisObject);
  const connectionStatusChangedSignal = new Signal<
    Session.ISessionConnection,
    Kernel.ConnectionStatus
  >(thisObject);
  const kernelChangedSignal = new Signal<
    Session.ISessionConnection,
    Session.ISessionConnection.IKernelChangedArgs
  >(thisObject);
  const iopubMessageSignal = new Signal<
    Session.ISessionConnection,
    KernelMessage.IIOPubMessage
  >(thisObject);

  const unhandledMessageSignal = new Signal<
    Session.ISessionConnection,
    KernelMessage.IMessage
  >(thisObject);

  kernel!.iopubMessage.connect((_, args) => {
    iopubMessageSignal.emit(args);
  }, thisObject);

  kernel!.statusChanged.connect((_, args) => {
    statusChangedSignal.emit(args);
  }, thisObject);

  (thisObject as any).disposed = disposedSignal;
  (thisObject as any).connectionStatusChanged = connectionStatusChangedSignal;
  (thisObject as any).propertyChanged = propertyChangedSignal;
  (thisObject as any).statusChanged = statusChangedSignal;
  (thisObject as any).kernelChanged = kernelChangedSignal;
  (thisObject as any).iopubMessage = iopubMessageSignal;
  (thisObject as any).unhandledMessage = unhandledMessageSignal;
  return thisObject;
});

/**
 * A mock session context.
 *
 * @param session The session connection object to use
 */
export const SessionContextMock = jest.fn<
  ISessionContext,
  [Partial<SessionContext.IOptions>, Session.ISessionConnection | null]
>((options, connection) => {
  const session =
    connection ||
    new SessionConnectionMock(
      {
        model: {
          path: options.path || '',
          type: options.type || '',
          name: options.name || ''
        }
      },
      null
    );
  const thisObject: ISessionContext = {
    ...jest.requireActual('@jupyterlab/apputils'),
    ...options,
    path: session.path,
    type: session.type,
    name: session.name,
    kernel: session.kernel,
    session,
    dispose: jest.fn(),
    initialize: jest.fn(() => Promise.resolve(void 0)),
    ready: Promise.resolve(void 0),
    changeKernel: jest.fn(partialModel => {
      return Private.changeKernel(
        session.kernel || Private.RUNNING_KERNELS[0],
        partialModel!
      );
    }),
    shutdown: jest.fn(() => Promise.resolve(void 0))
  };

  const disposedSignal = new Signal<ISessionContext, undefined>(thisObject);

  const propertyChangedSignal = new Signal<
    ISessionContext,
    'path' | 'name' | 'type'
  >(thisObject);

  const statusChangedSignal = new Signal<ISessionContext, Kernel.Status>(
    thisObject
  );
  const kernelChangedSignal = new Signal<
    ISessionContext,
    Session.ISessionConnection.IKernelChangedArgs
  >(thisObject);

  const iopubMessageSignal = new Signal<
    ISessionContext,
    KernelMessage.IIOPubMessage
  >(thisObject);

  session!.statusChanged.connect((_, args) => {
    statusChangedSignal.emit(args);
  }, thisObject);

  session!.iopubMessage.connect((_, args) => {
    iopubMessageSignal.emit(args);
  });

  session!.kernelChanged.connect((_, args) => {
    kernelChangedSignal.emit(args);
  });

  (thisObject as any).statusChanged = statusChangedSignal;
  (thisObject as any).kernelChanged = kernelChangedSignal;
  (thisObject as any).iopubMessage = iopubMessageSignal;
  (thisObject as any).propertyChanged = propertyChangedSignal;
  (thisObject as any).disposed = disposedSignal;
  (thisObject as any).session = session;

  return thisObject;
});

/**
 * A mock contents manager.
 */
export const ContentsManagerMock = jest.fn<Contents.IManager, []>(() => {
  const files: { [key: string]: Contents.IModel } = {};
  const checkpoints: { [key: string]: Contents.ICheckpointModel } = {};

  const thisObject: Contents.IManager = {
    ...jest.requireActual('@jupyterlab/services'),
    ready: Promise.resolve(void 0),
    newUntitled: jest.fn(options => {
      options = options || {};
      const name = UUID.uuid4() + options.ext || '.txt';
      const path = PathExt.join(options.path || '', name);
      let content = '';
      if (options.type === 'notebook') {
        content = JSON.stringify({});
      }
      const timeStamp = new Date().toISOString();
      const model: Contents.IModel = {
        path,
        content,
        name,
        last_modified: timeStamp,
        writable: true,
        created: timeStamp,
        type: options.type || 'file',
        format: 'text',
        mimetype: 'plain/text'
      };
      files[path] = model;
      fileChangedSignal.emit({
        type: 'new',
        oldValue: null,
        newValue: model
      });
      return Promise.resolve(model);
    }),
    createCheckpoint: jest.fn(path => {
      const lastModified = new Date().toISOString();
      checkpoints[path] = { id: UUID.uuid4(), last_modified: lastModified };
      return Promise.resolve();
    }),
    listCheckpoints: jest.fn(path => {
      if (checkpoints[path]) {
        return Promise.resolve([checkpoints[path]]);
      }
      return Promise.resolve([]);
    }),
    getModelDBFactory: jest.fn(() => {
      return null;
    }),
    normalize: jest.fn(path => {
      return path;
    }),
    localPath: jest.fn(path => {
      return path;
    }),
    get: jest.fn((path, _) => {
      if (!files[path]) {
        const resp = new Response(void 0, { status: 404 });
        return Promise.reject(new ServerConnection.ResponseError(resp));
      }
      return Promise.resolve(files[path]);
    }),
    save: jest.fn((path, options) => {
      const timeStamp = new Date().toISOString();
      if (files[path]) {
        files[path] = { ...files[path], ...options, last_modified: timeStamp };
      } else {
        files[path] = {
          path,
          name: PathExt.basename(path),
          content: '',
          writable: true,
          created: timeStamp,
          type: 'file',
          format: 'text',
          mimetype: 'plain/text',
          ...options,
          last_modified: timeStamp
        };
      }
      fileChangedSignal.emit({
        type: 'save',
        oldValue: null,
        newValue: files[path]
      });
      return Promise.resolve(files[path]);
    })
  };
  const fileChangedSignal = new Signal<
    Contents.IManager,
    Contents.IChangedArgs
  >(thisObject);
  (thisObject as any).fileChanged = fileChangedSignal;
  return thisObject;
});

/**
 * A mock sessions manager.
 */
export const SessionManagerMock = jest.fn<Session.IManager, []>(() => {
  const sessions: Session.IModel[] = [];
  const thisObject: Session.IManager = {
    ...jest.requireActual('@jupyterlab/services'),
    ready: Promise.resolve(void 0),
    startNew: jest.fn(options => {
      const session = new SessionConnectionMock({ model: options }, null);
      sessions.push(session.model);
      return session;
    }),
    connectTo: jest.fn(options => {
      return new SessionConnectionMock(options, null);
    }),
    refreshRunning: jest.fn(() => Promise.resolve(void 0)),
    running: jest.fn(() => new ArrayIterator(sessions))
  };
  return thisObject;
});

/**
 * A mock kernel specs manager
 */
export const KernelSpecManagerMock = jest.fn<KernelSpec.IManager, []>(() => {
  const thisObject: KernelSpec.IManager = {
    ...jest.requireActual('@jupyterlab/services'),
    specs: { default: KERNELSPECS[0].name, kernelspecs: KERNELSPECS },
    refreshSpecs: jest.fn(() => Promise.resolve(void 0))
  };
  return thisObject;
});

/**
 * A mock service manager.
 */
export const ServiceManagerMock = jest.fn<ServiceManager.IManager, []>(() => {
  const thisObject: ServiceManager.IManager = {
    ...jest.requireActual('@jupyterlab/services'),
    ready: Promise.resolve(void 0),
    contents: new ContentsManagerMock(),
    sessions: new SessionManagerMock(),
    kernelspecs: new KernelSpecManagerMock()
  };
  return thisObject;
});

/**
 * A mock kernel shell future.
 */
export const MockShellFuture = jest.fn<Kernel.IShellFuture, []>(() => {
  const thisObject: Kernel.IShellFuture = {
    ...jest.requireActual('@jupyterlab/services'),
    done: Promise.resolve(void 0)
  };
  return thisObject;
});

/**
 * A namespace for module private data.
 */
namespace Private {
  export function flattenArray<T>(arr: T[][]): T[] {
    const result: T[] = [];

    arr.forEach(innerArr => {
      innerArr.forEach(elem => {
        result.push(elem);
      });
    });

    return result;
  }

  export type RecursivePartial<T> = {
    [P in keyof T]?: RecursivePartial<T[P]>;
  };

  export function cloneKernel(
    options: RecursivePartial<Kernel.IKernelConnection.IOptions>
  ): Kernel.IKernelConnection {
    return new KernelMock(options);
  }

  // Get the kernel spec for kernel name
  export function kernelSpecForKernelName(name: string) {
    return KERNELSPECS.find(val => {
      return val.name === name;
    });
  }

  export function changeKernel(
    kernel: Kernel.IKernelConnection,
    partialModel: Partial<Kernel.IModel>
  ): Promise<Kernel.IModel> {
    if (partialModel.id) {
      const kernelIdx = KERNEL_MODELS.findIndex(model => {
        return model.id === partialModel.id;
      });
      if (kernelIdx !== -1) {
        (kernel.model as any) = RUNNING_KERNELS[kernelIdx].model;
        (kernel.id as any) = partialModel.id;
        return Promise.resolve(RUNNING_KERNELS[kernelIdx]);
      } else {
        throw new Error(
          `Unable to change kernel to one with id: ${partialModel.id}`
        );
      }
    } else if (partialModel.name) {
      const kernelIdx = KERNEL_MODELS.findIndex(model => {
        return model.name === partialModel.name;
      });
      if (kernelIdx !== -1) {
        (kernel.model as any) = RUNNING_KERNELS[kernelIdx].model;
        (kernel.id as any) = partialModel.id;
        return Promise.resolve(RUNNING_KERNELS[kernelIdx]);
      } else {
        throw new Error(
          `Unable to change kernel to one with name: ${partialModel.name}`
        );
      }
    } else {
      throw new Error(`Unable to change kernel`);
    }
  }

  // This list of running kernels simply mirrors the KERNEL_MODELS and KERNELSPECS lists
  export const RUNNING_KERNELS: Kernel.IKernelConnection[] = KERNEL_MODELS.map(
    (model, _) => {
      return new KernelMock({ model });
    }
  );

  export const lastMessageProperty = new AttachedProperty<
    Kernel.IKernelConnection,
    string
  >({
    name: 'lastMessageId',
    create: () => ''
  });
}
