import _ from 'lodash';
import fillShape from './utils/fill-shape';
import objectDifference from './utils/object-difference.js';

let globalName = '__REDUX_ELECTRON_STORE__';

/**
 * Creates a store enhancer which allows a redux store to synchronize its data
 * with an electronEnhanced store in the browser process.
 * @param {Object} p - The parameters to the creator
 * @param {Function} p.postDispatchCallback - A callback to run after a dispatch has occurred.
 * @param {Function} p.preDispatchCallback - A callback to run before an action is dispatched.
 * @param {String} p.sourceName - An override to the 'source' property appended to every action
*/
export default function electronBrowserEnhancer({
  postDispatchCallback: postDispatchCallback = (() => null),
  preDispatchCallback: preDispatchCallback = (() => null),
  sourceName: sourceName = null
} = {}) {
  return (storeCreator) => {
    return (reducer, initialState) => {
      let { ipcMain } = require('electron');

      let store = storeCreator(reducer, initialState);
      global[globalName] = store;

      let clients = {}; // webContentsId -> {webContents, filter, clientId, windowId}

      // Need to keep track of windows, as when a window refreshes it creates a new
      // webContents, and the old one must be unregistered
      let windowMap = {}; // windowId -> webContentsId

      let currentSource = sourceName || 'main_process';

      let unregisterRenderer = (webContentsId) => {
        delete clients[webContentsId];
      };

      let storeDotDispatch = store.dispatch;
      let doDispatch = (action) => {
        preDispatchCallback(action);
        storeDotDispatch(action);
        postDispatchCallback(action);
      };

      ipcMain.on(`${globalName}-register-renderer`, ({ sender }, { filter, clientId }) => {
        let webContentsId = sender.getId();
        clients[webContentsId] = {
          webContents: sender,
          filter,
          clientId,
          windowId: sender.getOwnerBrowserWindow().id
        };

        if (!sender.isGuest()) { // For windowMap (not webviews)
          let browserWindow = sender.getOwnerBrowserWindow();
          if (windowMap[browserWindow.id] !== undefined)
            unregisterRenderer(windowMap[browserWindow.id]);
          windowMap[browserWindow.id] = webContentsId;

          // Webcontents aren't automatically destroyed on window close
          browserWindow.on('closed', () => unregisterRenderer(webContentsId));
        }
      });

      let senderClientId = null;
      ipcMain.on(`${globalName}-renderer-dispatch`, ({ sender }, action) => {
        senderClientId = clients[sender.getId()].clientId;
        store.dispatch(JSON.parse(action));
        senderClientId = null;
      });

      store.dispatch = (action) => {
        if (!action) {
          storeDotDispatch(action);
          return;
        }
        action.source = action.source || currentSource;

        let prevState = store.getState();
        doDispatch(action);
        let newState = store.getState();
        let stateDifference = objectDifference(prevState, newState);

        for (let webContentsId in clients) {
          let webContents = clients[webContentsId].webContents;

          if (webContents.isDestroyed() || webContents.isCrashed()) {
            unregisterRenderer(webContentsId);
            return;
          }

          let shape = clients[webContentsId].filter;
          let updated = fillShape(stateDifference.updated, shape);
          let deleted = fillShape(stateDifference.deleted, shape);

          // If any data the renderer is watching changes, send an ipc
          // call to inform it of the updated and deleted data
          if (!_.isEmpty(updated) || !_.isEmpty(deleted)) {
            let payload = Object.assign({}, action, { data: { updated, deleted } });
            let transfer = { action: JSON.stringify(payload), sourceClientId: senderClientId || currentSource };
            webContents.send(`${globalName}-browser-dispatch`, transfer);
          }
        }
      };

      return store;
    };
  };
}
