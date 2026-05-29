export interface ReduxAction {
  [key: string]: unknown;
  type: string;
}

export interface StoreLike {
  dispatch: (action: ReduxAction) => unknown;
  getState: () => unknown;
}
