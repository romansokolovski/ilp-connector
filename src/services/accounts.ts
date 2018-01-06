'use strict'

import * as IlpPacket from 'ilp-packet'
import reduct = require('reduct')
import { cloneDeep } from 'lodash'
import compat from 'ilp-compat-plugin'
import Store from '../services/store'
import Config from './config'
import UnreachableError from '../errors/unreachable-error'
import { codes } from '../lib/ilp-errors'
import { AccountInfo } from '../types/accounts'
import {
  ConnectOptions,
  IPlugin,
  DataHandler,
  MoneyHandler
} from '../types/plugin'
import ILDCP = require('ilp-protocol-ildcp')

import { create as createLogger } from '../common/log'
const log = createLogger('accounts')

export interface AccountEntry {
  plugin: IPlugin,
  info: AccountInfo
}

export interface GenericDataHandler {
  (accountId: string, data: Buffer): Promise<Buffer>
}

export interface GenericMoneyHandler {
  (accountId: string, amount: string): Promise<void>
}

export default class Accounts {
  protected config: Config
  protected store: Store

  protected address: string
  protected accounts: Map<string, AccountEntry>
  protected dataHandler?: GenericDataHandler
  protected moneyHandler?: GenericMoneyHandler

  protected parentAccount?: string

  constructor (deps: reduct.Injector) {
    this.config = deps(Config)
    this.store = deps(Store)

    this.address = this.config.ilpAddress || 'unknown'
    this.accounts = new Map()
    this.dataHandler = undefined
    this.moneyHandler = undefined
    this.parentAccount = undefined
  }

  async connect (options: ConnectOptions) {
    // If we have no configured ILP address, try to get one via ILDCP
    if (this.config.ilpAddress === 'unknown') {
      if (this.parentAccount) {
        const parent = this.getPlugin(this.parentAccount)

        await parent.connect({})

        const ildcpInfo = await ILDCP.fetch(parent.sendData.bind(parent))

        this.setOwnAddress(ildcpInfo.clientAddress)
      } else {
        log.error('no ilp address configured and no parent account found, cannot determing ilp address.')
        throw new Error('no ilp address configured.')
      }
    }
    const accounts = Array.from(this.accounts.values())
    return Promise.all(accounts.map(account => account.plugin.connect(options)))
  }

  getOwnAddress () {
    return this.address
  }

  setOwnAddress (newAddress) {
    log.info('setting ilp address. oldAddress=%s newAddress=%s', this.address, newAddress)
    this.address = newAddress
  }

  getPlugin (accountId: string) {
    const account = this.accounts.get(accountId)

    if (!account) {
      log.warn('could not find plugin for account id. accountId=%s', accountId)
      throw new Error('unknown account id. accountId=' + accountId)
    }

    return account.plugin
  }

  exists (accountId: string) {
    return this.accounts.has(accountId)
  }

  getAccountIds () {
    return Array.from(this.accounts.keys())
  }

  getParentId () {
    return this.parentAccount
  }

  getAssetCode (accountId: string) {
    const account = this.accounts.get(accountId)

    if (!account) {
      log.debug('no currency found. account=%s', accountId)
      return
    }

    return account.info.assetCode
  }

  add (accountId: string, creds: any) {
    log.info('add account. accountId=%s', accountId)

    creds = cloneDeep(creds)

    try {
      this.config.validateAccount(accountId, creds)
    } catch (err) {
      if (err.name === 'InvalidJsonBodyError') {
        log.warn('validation error in account config. id=%s', accountId)
        err.debugPrint(log.warn)
        throw new Error('error while adding account, see error log for details.')
      }

      throw err
    }

    if (creds.relation === 'parent') {
      if (this.parentAccount) {
        throw new Error('only one account may be marked as relation=parent. id=' + accountId)
      }

      this.parentAccount = accountId
    }

    const store = this.store.getPluginStore(accountId)

    const Plugin = require(creds.plugin)
    const plugin = compat(new Plugin(Object.assign({}, creds.options, {
      // non JSON-stringifiable fields are prefixed with an underscore
      _store: store,
      _log: createLogger(creds.plugin)
    })))

    this.accounts.set(accountId, {
      info: creds,
      plugin
    })

    plugin.registerDataHandler(this._handleData.bind(this, accountId))
    plugin.registerMoneyHandler(this._handleMoney.bind(this, accountId))
  }

  remove (accountId: string) {
    const plugin = this.getPlugin(accountId)
    if (!plugin) {
      return
    }
    log.info('remove account. accountId=' + accountId)
    plugin.deregisterDataHandler()
    plugin.deregisterMoneyHandler()

    if (this.parentAccount === accountId) {
      this.parentAccount = undefined
    }

    this.accounts.delete(accountId)
    return plugin
  }

  async _handleData (accountId: string, data: Buffer) {
    try {
      if (!this.dataHandler) {
        log.debug('no data handler, rejecting. from=%s', accountId)
        throw new UnreachableError('connector not ready.')
      }

      const response = await this.dataHandler(accountId, data)

      if (!Buffer.isBuffer(response)) {
        throw new Error('handler did not return a value.')
      }

      return response
    } catch (e) {
      let err = e
      if (!err || typeof err !== 'object') {
        err = new Error('Non-object thrown: ' + e)
      }

      log.debug('error in data handler. error=%s', err.stack ? err.stack : err)

      if (err.name === 'InsufficientBalanceError') {
        err.ilpErrorCode = codes.T04_INSUFFICIENT_LIQUIDITY
      }

      return IlpPacket.serializeIlpReject({
        code: err.ilpErrorCode || codes.F00_BAD_REQUEST,
        message: err.message ? err.message : String(err),
        triggeredBy: this.getOwnAddress(),
        data: Buffer.alloc(0)
      })
    }
  }

  async _handleMoney (accountId: string, amount: string) {
    if (!this.moneyHandler) {
      log.debug('no money handler, ignoring. from=%s', accountId)
      return
    }

    return this.moneyHandler(accountId, amount)
  }

  registerDataHandler (dataHandler: GenericDataHandler) {
    if (this.dataHandler) {
      throw new Error('data handler already registered.')
    }
    this.dataHandler = dataHandler
  }

  deregisterDataHandler () {
    this.dataHandler = undefined
  }

  registerMoneyHandler (moneyHandler: GenericMoneyHandler) {
    if (this.moneyHandler) {
      throw new Error('money handler already registered.')
    }
    this.moneyHandler = moneyHandler
  }

  deregisterMoneyHandler () {
    this.moneyHandler = undefined
  }

  getInfo (accountId: string) {
    const account = this.accounts.get(accountId)

    if (!account) {
      throw new Error('unknown account id. accountId=' + accountId)
    }

    return account.info
  }

  getChildAddress (accountId: string) {
    const info = this.getInfo(accountId)

    if (info.relation !== 'child') {
      throw new Error('Can\'t generate child address for account that is isn\'t a child')
    }

    const ilpAddressSegment = info.ilpAddressSegment || accountId

    return this.config.ilpAddress + '.' + ilpAddressSegment
  }
}