/* global Y, IDBKeyRange, indexedDB, localStorage, IDBRequest, IDBOpenDBRequest, IDBCursor, IDBCursorWithValue, addEventListener */
'use strict'

function extend (Y) {
  Y.requestModules(['memory']).then(function () {
    class Store {
      constructor (transaction, name) {
        this.store = transaction.objectStore(name)
      }
      * find (id) {
        return yield this.store.get(id)
      }
      * put (v) {
        yield this.store.put(v)
      }
      * delete (id) {
        yield this.store.delete(id)
      }
      * findWithLowerBound (start) {
        return yield this.store.openCursor(IDBKeyRange.lowerBound(start))
      }
      * findWithUpperBound (end) {
        return yield this.store.openCursor(IDBKeyRange.upperBound(end), 'prev')
      }
      * findNext (id) {
        return yield* this.findWithLowerBound([id[0], id[1] + 1])
      }
      * findPrev (id) {
        return yield* this.findWithUpperBound([id[0], id[1] - 1])
      }
      * iterate (t, start, end, gen) {
        var range = null
        if (start != null && end != null) {
          range = IDBKeyRange.bound(start, end)
        } else if (start != null) {
          range = IDBKeyRange.lowerBound(start)
        } else if (end != null) {
          range = IDBKeyRange.upperBound(end)
        }
        var cursorResult
        if (range != null) {
          cursorResult = this.store.openCursor(range)
        } else {
          cursorResult = this.store.openCursor()
        }
        while ((yield cursorResult) != null) {
          yield* gen.call(t, cursorResult.result.value)
          cursorResult.result.continue()
        }
      }
      * flush () {}
    }

    function createStoreClone (Store) {
      class Clone extends Store {
        constructor () {
          super(...arguments)
          this.buffer = []
          this._copyTo = null
        }
        // copy to this store
        // it may be neccessary to reset this every time you create a transaction
        copyTo (store) {
          this._copyTo = store
          return this
        }
        * put (v, dontCopy) {
          if (!dontCopy) {
            this.buffer.push(this._copyTo.put(v))
          }
          yield* super.put(v)
        }
        * delete (id) {
          this.buffer.push(this._copyTo.delete(id))
          yield* super.delete(id)
        }
        * flush () {
          yield* super.flush()
          for (var i = 0; i < this.buffer.length; i++) {
            yield* this.buffer[i]
          }
          yield* this._copyTo.flush()
        }
      }
      return Clone
    }
    Y.utils.createStoreClone = createStoreClone

    var BufferedStore = Y.utils.createSmallLookupBuffer(Store)
    // var ClonedStore = Y.utils.createStoreClone(Y.utils.RBTree)

    class Transaction extends Y.Transaction {
      constructor (store) {
        super(store)
        var transaction = store.db.transaction(['OperationStore', 'StateStore', 'DeleteStore'], 'readwrite')
        this.store = store
        this.ss = new BufferedStore(transaction, 'StateStore')
        this.os = new BufferedStore(transaction, 'OperationStore')
        // this._ds = new BufferedStore(transaction, 'DeleteStore')
        // this.ds = store.dsClone.copyTo(this._ds)
        this.ds = new BufferedStore(transaction, 'DeleteStore')
      }
    }
    class OperationStore extends Y.AbstractDatabase {
      constructor (y, options) {
        /**
         * There will be no garbage collection when using this connector!
         * There may be several instances that communicate via localstorage,
         * and we don't want too many instances to garbage collect.
         * Currently, operationAdded (see AbstractDatabase) does not communicate updates to the garbage collector.
         *
         * While this could work, it only decreases performance.
         * Operations are automatically garbage collected when the client syncs (the server still garbage collects, if there is any).
         * Another advantage is that now the indexeddb adapter works with y-webrtc (since no gc is in place).
         *
         */
        if (options.gc == null) {
          options.gc = false
        }
        super(y, options)
        // dsClone is persistent over transactions!
        // _ds is not
        // this.dsClone = new ClonedStore()
        if (options == null) {
          options = {}
        }
        this.options = options
        if (options.namespace == null) {
          if (y.options.connector.room == null) {
            throw new Error('IndexedDB: expect a string (options.namespace)! (you can also skip this step if your connector has a room property)')
          } else {
            options.namespace = y.options.connector.room
          }
        }
        if (options.idbVersion != null) {
          this.idbVersion = options.idbVersion
        } else {
          this.idbVersion = 5
        }
        var store = this
        if(!options.userId) {
          throw new Error("userId is required")
        }
        // initialize database!
        this.requestTransaction(function * () {
          store.db = yield indexedDB.open(options.namespace, store.idbVersion)
        })
        if (options.cleanStart) {
          if (typeof localStorage !== 'undefined') {
            delete localStorage[JSON.stringify(['Yjs_indexeddb', options.namespace])]
          }
          this.requestTransaction(function * () {
            yield this.os.store.clear()
            yield this.ds.store.clear() // formerly only _ds
            yield this.ss.store.clear()
          })
        }
        this.whenUserIdSet(function (userid) {
          if (typeof localStorage !== 'undefined' && localStorage[JSON.stringify(['Yjs_indexeddb', options.namespace])] == null) {
            localStorage[JSON.stringify(['Yjs_indexeddb', options.namespace])] = JSON.stringify([userid, 0])
          }
        })
        this.requestTransaction(function * () {
          // custom code, just set userId that is passed in the options
          store.setUserId(options.userId)
        })
      }
      * operationAdded (transaction, op, noAdd) {
        yield* super.operationAdded(transaction, op)
        if (!noAdd) {
          // broadcast to other externsion's pages here
          //Y.utils.localCommunication.broadcast(this.options.namespace, op)
        }
      }
      transact (makeGen) {
        var transaction = this.db != null ? new Transaction(this) : null
        var store = this

        var gen = makeGen.call(transaction)
        handleTransactions(gen.next())

        function handleTransactions (result) {
          var request = result.value
          if (result.done) {
            makeGen = store.getNextRequest()
            if (makeGen != null) {
              if (transaction == null && store.db != null) {
                transaction = new Transaction(store)
              }
              gen = makeGen.call(transaction)
              handleTransactions(gen.next())
            } // else no transaction in progress!
            return
          }
          // console.log('new request', request.source != null ? request.source.name : null)
          if (request.constructor === IDBRequest) {
            request.onsuccess = function () {
              var res = request.result
              if (res != null && res.constructor === IDBCursorWithValue) {
                res = res.value
              }
              handleTransactions(gen.next(res))
            }
            request.onerror = function (err) {
              gen.throw(err)
            }
          } else if (request.constructor === IDBCursor) {
            request.onsuccess = function () {
              handleTransactions(gen.next(request.result != null ? request.result.value : null))
            }
            request.onerror = function (err) {
              gen.throw(err)
            }
          } else if (request.constructor === IDBOpenDBRequest) {
            request.onsuccess = function (event) {
              var db = event.target.result
              handleTransactions(gen.next(db))
            }
            request.onerror = function () {
              gen.throw("Couldn't open IndexedDB database!")
            }
            request.onupgradeneeded = function (event) {
              var db = event.target.result
              if (typeof localStorage !== 'undefined') {
                delete localStorage[JSON.stringify(['Yjs_indexeddb', store.options.namespace])]
              }
              if (db.objectStoreNames.contains('OperationStore')) {
                // delete only if exists (we skip the remaining tests)
                db.deleteObjectStore('OperationStore')
                db.deleteObjectStore('DeleteStore')
                db.deleteObjectStore('StateStore')
              }
              db.createObjectStore('OperationStore', {keyPath: 'id'})
              db.createObjectStore('DeleteStore', {keyPath: 'id'})
              db.createObjectStore('StateStore', {keyPath: 'id'})
            }
          } else {
            gen.throw('You must not yield this type!')
          }
        }
      }
      // TODO: implement "free"..
      * destroy () {
        this.db.close()
      }
      deleteDB () {
        Y.utils.localCommunication.removeObserver(this.options.namespace, this.communicationObserver)
        indexedDB.deleteDatabase(this.options.namespace)
        return Promise.resolve()
      }
    }
    Y.extend('indexeddb-webext', OperationStore)
  })
}

module.exports = extend
if (typeof Y !== 'undefined') {
  extend(Y)
}
