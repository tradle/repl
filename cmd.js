#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const repl = require('repl')
const mkdirp = require('mkdirp')
const rimraf = require('rimraf')
const typeforce = require('typeforce')
const leveldown = require('leveldown')
const writeAtomic = require('write-file-atomic')
// todo: require directly
const levelEncrypt = require('level-encrypt')
const tradle = require('@tradle/engine')
const Wallet = require('@tradle/simple-wallet')
const createKeeper = require('@tradle/keeper')
// const Blockchain = require('cb-http-client')
const Blockchain = require('@tradle/cb-blockr')
const installHistory = require('./history')
const blockchains = {}

const utils = tradle.utils
const encryptionOpts = Object.freeze({
  // key derivation parameters
  saltBytes: 32,
  digest: 'sha256',
  keyBytes: 32,
  iterations: 64000,
  // encryption parameters
  algorithm:'aes-256-cbc',
  ivBytes: 16,
  password: null
})

const replServer = repl.start({
  prompt: 'tradle > ',
})

installHistory(replServer)

const tradleDir = path.join(process.env.HOME, '.tradle')
const accountsDir = path.join(tradleDir, 'accounts')
const accounts = []
const identityByHandle = {}

try {
  fs.readdirSync(accountsDir).forEach(handle => {
    const identity = require(getIdentityPath(handle))
    addAccountIdentity(handle, identity)
  })
} catch (err) {}

const context = replServer.context
startTradleRepl()

function startTradleRepl () {
  const networkName = 'testnet'
  const syncInterval = 60000
  const confirmedAfter = 10

  context.login = login
  context.logout = logout
  context.deleteAccount = deleteAccount
  context.createAccount = createAccount
  context.networkName = networkName
  context.syncInterval = syncInterval
  context.confirmedAfter = confirmedAfter
  context.accounts = accounts
  context.help = help

  const initScript = process.argv[2]
  if (initScript) {
    const scriptBody = fs.readFileSync(path.resolve(initScript), { encoding: 'utf8' })
    vm.createContext(context)
    vm.runInContext(scriptBody, context)
    replServer.displayPrompt()
  }
}

function logout (cb) {
  cb = utils.asyncify(cb || rethrow)
  if (!context.node) return cb(new Error('not logged in'))

  context.node.destroy(err => {
    if (err) return cb(err)

    delete context.node
    delete context.logout
    cb()
  })
}

function normalizeLoginOpts (handle, password) {
  return tradle.utils.clone(encryptionOpts, {
    handle: handle.toLowerCase(),
    password
  })
}

function loadKeys (handle, password) {
  const opts = normalizeLoginOpts(handle, password)
  const encryptedKeys = fs.readFileSync(getKeysPath(handle))
  return levelEncrypt.decrypt(encryptedKeys, opts)
}

function login (handle, password, cb) {
  typeforce(typeforce.String, handle)
  typeforce(typeforce.String, password)

  cb = cb || utils.asyncify(cb || rethrow)
  if (accounts.indexOf(handle) === -1) cb(new Error('no such account'))
  if (context.node) {
    return logout(() => {
      login(handle, password, cb)
    })
  }

  // const accountDir = path.join(accountsDir, handle)
  const opts = normalizeLoginOpts(handle, password)
  const keys = loadKeys(handle, password)
  const networkName = context.networkName
  const blockchain = getBlockchain(networkName)
  const priv = keys.filter(k => {
    return k.type === 'bitcoin' && k.networkName === context.networkName
  })[0].priv

  const transactor = Wallet.transactor({
    wallet: new Wallet({ priv, blockchain, networkName })
  })

  const keeper = createKeeper({
    encryption: opts,
    path: getKeeperPath(handle),
    db: leveldown,
    validateOnPut: true
  })

  const dir = getAccountDataPath(handle)
  mkdirp.sync(dir)

  const node = context.node = new tradle.node({
    dir,
    networkName,
    blockchain,
    transactor,
    keys,
    leveldown,
    keeper,
    identity: identityByHandle[handle],
    syncInterval: context.syncInterval,
    confirmedAfter: context.confirmedAfter
  })

  node.on('destroy', () => keeper.close())

  context.logout = logout

  console.log('`node` variable set')
  cb()
}

function checkPassword (handle, password) {
  loadKeys(handle, password)
}

function deleteAccount (handle, password) {
  // check password
  checkPassword(handle, password)

  const idx = accounts.indexOf(handle)
  if (idx !== -1) {
    rimraf.sync(getAccountPath(handle))
    accounts.splice(idx, 1)
    delete identityByHandle[handle]
  }
}

function createAccount (handle, password, cb) {
  handle = handle.toLowerCase()
  cb = utils.asyncify(cb || rethrow)
  if (accounts.indexOf(handle) !== -1) return cb(new Error(`account "${handle}" already exists`))

  tradle.utils.newIdentity({
    networkName: context.networkName,
  }, function (err, identityInfo) {
    if (err) return cb(err)

    const identity = identityInfo.identity
    const opts = tradle.utils.clone(encryptionOpts)
    opts.password = password
    const encryptedKeys = levelEncrypt.encrypt(JSON.stringify(identityInfo.keys), opts)
    mkdirp.sync(getAccountPath(handle))
    writeAtomic.sync(getKeysPath(handle), encryptedKeys)
    writeAtomic.sync(getIdentityPath(handle), JSON.stringify(identity))
    addAccountIdentity(handle, identity)
    cb()
  })
}

function addAccountIdentity (handle, identity) {
  accounts.push(handle)
  identityByHandle[handle] = identity
}

function getAccountPath (handle) {
  return path.join(accountsDir, handle)
}

function getKeysPath (handle) {
  return path.join(accountsDir, handle, 'keys')
}

function getIdentityPath (handle) {
  return path.join(accountsDir, handle, 'identity.json')
}

function getKeeperPath (handle) {
  return path.join(accountsDir, handle, 'keeper')
}

function getAccountDataPath (handle) {
  return path.join(accountsDir, handle, 'data')
}

function getBlockchain (networkName) {
  if (!blockchains[networkName]) {
    blockchains[networkName] = new Blockchain(networkName)
  }

  return blockchains[networkName]
}

function log () {
  return console.log.apply(console, arguments)
}

function help (commandOrConstant) {
  if (!commandOrConstant) {
    return [
      'logout', 'login', 'createAccount', 'deleteAccount', 'help', 'accounts',
      'networkName', 'confirmedAfter', 'syncInterval', 'node'
    ].forEach(k => {
      console.log(k + ': ')
      help(k)
    })
  }

  commandOrConstant = commandOrConstant || 'help'
  const match = typeof commandOrConstant === 'string' ? context[commandOrConstant] : commandOrConstant
  const info = typeof match === 'function' ? getFunctionInfo(match) : 'constant'

  switch (match) {
  case context.logout:                    return printUsage('log out of the current account')
  case context.login:                     return printUsage('log in to an account')
  case context.createAccount:             return printUsage('create a new account')
  case context.deleteAccount:             return printUsage('delete an account')
  case context.help:                      return printUsage('print usage for a command or constant')
  case context.accounts:                  return printUsage('existing accounts list')
  case context.networkName:               return printUsage('the current network being used')
  case context.confirmedAfter:            return printUsage('how many confirmations to monitor transactions for')
  case context.syncInterval:              return printUsage('how often to sync with the blockchain (ms)')
  case context.node:                      return printUsage('the logged in account\'s node')
  default: {
    log('unknown command or constant\n')
    return help()
  }
  }

  function printUsage (str) {
    log(`  ${info}: ${str}`)
  }
}

function getFunctionInfo (fn) {
  // try {
  return fn.toString().match(/(function ?[^\(]+ ?\([^\)]+\))/)[1]
  // } catch (err) {
  //   console.log(fn.toString())
  // }
}

function rethrow (err) {
  if (err) throw err
}
