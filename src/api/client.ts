import * as assert from "assert";

const Url = require("url");
const querystring = require("querystring");
const crypto = require("crypto");
const Agent = require("agentkeepalive");
const HttpsAgent = require("agentkeepalive").HttpsAgent;
const FormStream = require("formstream");
const urllib = require("urllib");
const utility = require("utility");

const URLLIB = Symbol("URLLIB");
const CACHE = Symbol("CACHE");
const LRU = Symbol("LRU");

interface IJSApiConfig {
  signature: string;
  nonceStr: string;
  timeStamp: number;
}

/*
 * 鉴权 && 请求相关 API
 * @type {Client}
 */
export class Client {
  /*
   * Client 构造函数
   * @param {Object} options 配置参数
   *  - {String} corpId     - 应用corpId
   *  - {String} appKey     - 应用appKey
   *  - {String} appSecret  - 应用appSecret
   *  - {String} host - 钉钉服务接口地址
   *  - {Object} [requestOpts] - urllib 默认请求参数
   * @constructor
   */
  constructor(private readonly options) {
    // assert(options.corpId, "options.corpId required");
    assert(options.appKey, "options.appKey required");
    assert(options.appSecret, "options.应用appSecret required");
    assert(options.host, "options.host required");

    this.options = Object.assign({
      accessTokenLifeTime: (7200 - 1000) * 1000,
      jsapiTicketLifeTime: (7200 - 1000) * 1000
    }, options);
  }

  /*
   * 返回 options.cache 实例或者初始化一个
   * @return {Object} cache 实例
   */
  get cache() {
    if (!this[CACHE]) {
      if (this.options.cache) {
        this[CACHE] = this.options.cache;
      } else {
        if (!this[LRU]) {
          this[LRU] = {};
        }
        const LRU_CACHE = this[LRU];
        this[CACHE] = {
          get(key) {
            if (LRU_CACHE[key] && (LRU_CACHE[key].expired > Date.now())) {
              return LRU_CACHE[key].value;
            }
            return null;
          },
          set(key, value, maxAge) {
            const obj = {
              expired: maxAge,
              value
            };
            LRU_CACHE[key] = obj;
            return obj;
          }
        };
      }
    }
    return this[CACHE];
  }

  /*
   * 返回 option.urlib 实例或者根据配置初始化一个
   * @return {Object} urlib 实例
   * @see https://www.npmjs.com/package/urllib
   */
  get urllib() {
    if (!this[URLLIB]) {
      // 直接传递 urllib 实例
      if (this.options.urllib && this.options.urllib.request) {
        this[URLLIB] = this.options.urllib;
      } else {
        // urllib 配置
        const opts = Object.assign({
          keepAlive: true,
          keepAliveTimeout: 30000,
          timeout: 30000,
          maxSockets: Infinity,
          maxFreeSockets: 256
        }, this.options.urllib);

        this[URLLIB] = urllib.create({
          agent: new Agent(opts),
          httpsAgent: new HttpsAgent(opts)
        });
      }
    }
    return this[URLLIB];
  }

  /*
   * send http request
   * @param {String} url 请求地址
   * @param {Object} [params] 请求参数
   * @return {Object} 返回结果的 data
   */
  async request(url, params) {
    const requestParams = Object.assign({ dataType: "json" }, this.options.requestOpts, params);

    // 如果有配置代理，则设置代理信息
    if (this.options.proxy) {
      url = url.replace(this.options.host, this.options.proxy);
    }

    let response;
    try {
      response = await this.urllib.request(url, requestParams);
    } catch (err) {
      if (this.options.logger) {
        this.options.logger.warn("[node-dingTalk:client:request:error] %s %s %s, headers: %j, error: %j",
          requestParams.method || "GET", url, err.status, err.headers, err);
      }
      throw err;
    }

    const result = response.data;
    if (this.options.logger) {
      this.options.logger.info("[node-dingTalk:client:request:response] %s %s %s, headers: %j, result: %j",
        requestParams.method || "GET", url, response.status, response.headers, result);
    }
    if (result) {
      if (result.errcode !== 0) {
        const err: any = new Error(`${url} got error: ${JSON.stringify(result)}`);
        err.name = "DingTalkClientResponseError";
        err.code = result.errcode;
        err.data = result;
        throw err;
      } else {
        return result;
      }
    } else {
      return response;
    }
  }

  /*
   * upload file
   * @param {String} url 请求地址
   * @param {Object} fileInfo 文件信息 { field, path }
   * @param {Object} [fields] 其他信息
   * @return {Object} 操作结果
   */
  async upload(url, fileInfo, fields?) {
    assert(fileInfo.field, "fileInfo.field required");
    assert(fileInfo.path, "fileInfo.path required");

    const form = FormStream();
    if (fields) {
      for (const key of Object.keys(fields)) {
        form.field(key, fields[key]);
      }
    }
    form.file(fileInfo.field, fileInfo.path);

    return this.request(url, {
      method: "POST",
      headers: form.headers(),
      stream: form
    });
  }

  /*
   * send GET request to dingTalk
   * @param {String} api - api name, not need start with `/`
   * @param {Object} [data] - query object
   * @param {Object} [opts] - urllib opts
   * @return {Object} response.data
   */
  async get(api, data?, opts?) {
    assert(api, "api path required");
    let accessToken = opts && opts.accessToken;
    if (!accessToken) {
      accessToken = await this.getAccessToken();
    }
    const url = `${this.options.host}/${api}`;
    return this.request(url, Object.assign({ data: Object.assign({ access_token: accessToken }, data) }, opts));
  }

  /*
   * send POST request to dingtalk
   * @param {String} api - api name, not need start with `/`
   * @param {Object} [data] - post body object
   * @param {Object} [opts] - urllib opts
   * @return {Object} response.data
   */
  async post(api, data, opts?) {
    assert(api, "api path required");
    let accessToken = opts && opts.accessToken;
    if (!accessToken) {
      accessToken = await this.getAccessToken();
    }
    const url = `${this.options.host}/${api}?access_token=${encodeURIComponent(accessToken)}`;
    return this.request(url, Object.assign({
      method: "POST",
      contentType: "json",
      data
    }, opts));
  }

  /**
   * 获取网站应用钉钉扫码登录 URL，用于网站本身偷懒不想单独做一个登录页面的情况
   * https://open-doc.dingtalk.com/docs/doc.htm?treeId=168&articleId=104882&docType=1
   * @param {Object} [query] - qrconnect url params
   * @param {String} [query.appid] - 钉钉应用 id
   * @param {String} [query.redirect_uri] - 登录成功后的回跳 URL，必须跟钉钉应用后台配置的一致
   * @return {String} qrconnect url
   */
  async getQRConnectUrl(query) {
    const params = Object.assign({
      response_type: "code",
      scope: "snsapi_login",
      state: "STATE",
      appid: this.options.appid, // 必填
      redirect_uri: this.options.redirect_uri // 必填
    }, query);
    return `${this.options.host}/connect/qrconnect?${querystring.stringify(params)}`;
  }

  /*
   * 获取 iframe 形式内嵌二维码的登录 goto
   * https://open-doc.dingtalk.com/docs/doc.htm?treeId=168&articleId=104882&docType=1
   * @param {Object} [query] - qrconnect url params
   * @param {String} [query.appid] - 钉钉应用 id
   * @param {String} [query.redirect_uri] - 登录成功后的回跳 URL，必须跟钉钉应用后台配置的一致
   * @return {String} qrconnect url
   */
  async getIframeQRGotoUrl(query) {
    const params = Object.assign({
      response_type: "code",
      scope: "snsapi_login",
      state: "STATE",
      appid: this.options.appid, // 必填
      redirect_uri: this.options.redirect_uri // 必填
    }, query);
    return `${this.options.host}/connect/oauth2/sns_authorize?${querystring.stringify(params)}`;
  }

  /*
   * 如果钉钉用户通过钉钉客户端访问你的H5应用时，则需要由你构造并引导用户跳转到如下链接。
   * https://open-doc.dingtalk.com/docs/doc.htm?treeId=168&articleId=104881&docType=1
   * @param {Object} [query] - qrconnect url params
   * @param {String} [query.appid] - 钉钉应用 id
   * @param {String} [query.redirect_uri] - 登录成功后的回跳 URL，必须跟钉钉应用后台配置的一致
   * @return {String} qrconnect url
   */
  async getWebAuthUrl(query) {
    const params = Object.assign({
      response_type: "code",
      scope: "snsapi_auth",
      state: "STATE",
      appid: this.options.appid, // 必填
      redirect_uri: this.options.redirect_uri // 必填
    }, query);
    return `${this.options.host}/connect/oauth2/sns_authorize?${querystring.stringify(params)}`;
  }

  /*
   * 钉钉用户访问你的Web系统时，如果用户选择使用钉钉账号登录，则需要由你构造并引导用户跳转到如下链接。
   * https://open-doc.dingtalk.com/docs/doc.htm?treeId=168&articleId=104881&docType=1
   * @param {Object} [query] - qrconnect url params
   * @param {String} [query.appid] - 钉钉应用 id
   * @param {String} [query.redirect_uri] - 登录成功后的回跳 URL，必须跟钉钉应用后台配置的一致
   * @return {String} qrconnect url
   */
  async getWebLoginUrl(query) {
    const params = Object.assign({
      response_type: "code",
      scope: "snsapi_login",
      state: "STATE",
      appid: this.options.appid, // 必填
      redirect_uri: this.options.redirect_uri // 必填
    }, query);
    return `${this.options.host}/connect/oauth2/sns_authorize?${querystring.stringify(params)}`;
  }

  /*
   * 获取 iframe goto 成功后的最终跳转验证 URL
   * https://open-doc.dingtalk.com/docs/doc.htm?treeId=168&articleId=104882&docType=1
   * @param {Object} query - qrconnect url params
   * @param {String} query.loginTmpCode - 一次性临时登录验证 code
   * @param {String} [query.appid] - 钉钉应用 id
   * @param {String} [query.redirect_uri] - 登录成功后的回跳 URL，必须跟钉钉应用后台配置的一致
   * @return {String} qrconnect url
   */
  async getSnsAuthorizeUrl(query) {
    assert(query && query.loginTmpCode, "loginTmpCode required");
    const params = Object.assign({
      response_type: "code",
      scope: "snsapi_login",
      state: "STATE",
      appid: this.options.appid, // 必填
      redirect_uri: this.options.redirect_uri // 必填
    }, query);
    return `${this.options.host}/connect/oauth2/sns_authorize?${querystring.stringify(params)}`;
  }

  /*
   * 获取 AccessToken, 并在有效期内自动缓存
   * @return {String} accessToken
   */
  async getAccessToken() {
    const { appKey, appSecret } = this.options;
    const cacheKey = "accessToken_" + utility.md5(`${appKey}|${appSecret}`);
    let accessToken = await this.cache.get(cacheKey);
    if (!accessToken) {
      let url = `${this.options.host}/gettoken`;
      let data = { appkey: appKey, appsecret: appSecret };

      const response = await this.request(url, { data });
      const accessTokenExpireTime = Date.now() + this.options.accessTokenLifeTime;
      accessToken = response.access_token;
      await this.cache.set(cacheKey, accessToken, accessTokenExpireTime);
      return accessToken;
    }
    return accessToken;
  }

  /*
   * 获取 jsapi_ticket, 并在有效期内自动缓存
   *  - get_jsapi_ticket
   * @return {String} jsapiTicket
   * @see https://open-doc.dingtalk.com/doc2/detail.htm?treeId=172&articleId=104966&docType=1
   */
  async getJSApiTicket() {
    let ticket = await this.cache.get("jsapiTicket");
    if (!ticket) {
      const response = await this.get("get_jsapi_ticket", { type: "jsapi" });
      const jsapiTicketExpireTime = Date.now() + Math.min(response.expires_in * 1000, this.options.jsapiTicketLifeTime);
      ticket = response.ticket;
      await this.cache.set("jsapiTicket", ticket, jsapiTicketExpireTime);
      return ticket;
    }
    return ticket;
  }

  /*
   * 对签名用的 url 做处理
   *  - 干掉 hash
   *  - query 参数需要做 url decode, 不能包含 %2F 等
   * @param {String} url 需转换的 url
   * @return {String} 转换后的 url
   * @private
   * @see https://open-doc.dingtalk.com/doc2/detail.htm?spm=a219a.7386797.0.0.WXYE3B&treeId=171&articleId=104934&docType=1
   */
  _normalizeUrl(url) {
    // url 处理, 干掉 hash, query 需做 url decode
    const originUrlObj = Url.parse(url, true);
    const queryStr = Object.keys(originUrlObj.query).reduce((result, key) => {
      const value = originUrlObj.query[key];
      result.push(`${key}=${(value)}`);
      return result;
    }, []).join("&");
    delete originUrlObj.hash;
    delete originUrlObj.query;
    delete originUrlObj.search;
    return Url.format(originUrlObj) + (queryStr ? "?" + queryStr : "");
  }

  /*
   * 获取 js api 接入时需要的配置数据
   * @param {String} url 当前页面的地址
   * @param {Object} [opts] 其他参数, 包括 noncestr, timestamp
   */
  async getJSApiConfig(url: string, opts?): Promise<IJSApiConfig> {
    const ticket = await this.getJSApiTicket();
    const signObj = Object.assign({
      jsapi_ticket: ticket,
      noncestr: "Index#" + Date.now(),
      timestamp: Date.now(),
      url: this._normalizeUrl(url)
    }, opts);

    const signContent = Object
      .keys(signObj)
      .sort()
      .map(key => `${key}=${signObj[key]}`)
      .join("&");
    const signature = crypto
      .createHash("sha1")
      .update(signContent, "utf8")
      .digest("hex");

    return {
      signature,
      nonceStr: signObj.noncestr,
      timeStamp: signObj.timestamp
    };
  }
}
