const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  cozyClient
} = require('cozy-konnector-libs')
const KJUR = require('jsrsasign')
const request = requestFactory({
  json: true
})

const VENDOR = 'Jobready'
const baseUrl = 'https://visionstrust.com/v1'
const serviceKey =
  'SlQ03OMYYo3MAGSdM2UqUuVEGf2Je81N63tUa81D8LgK8CAbxPoSELxmLPtpLGvXdp8ckPAvs6BtuHTeNTjPcoS1SwwumLZjjRd4'
const secretKey = 'LjldXJAX6MJm2qi'
const client = cozyClient.new

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
async function start(fields, cozyParameters) {
  log('info', 'Start konnector ...')

  try {
    const payload = process.env.COZY_PAYLOAD || {}
    log('info', `payload : ${payload}`)
    if (payload.serviceExportUrl && payload.signedConsent) {
      await consentImport()
      return
    } else if (payload.signedConsent && payload.data && payload.user) {
      // TODO import
      console.log('import')
      return
    }

    log('info', `Start consent exchange...`)

    const email = fields.login
    const url = process.env.COZY_URL.replace(/(^\w+:|^)\/\//, '')

    const cozyFields = JSON.parse(process.env.COZY_FIELDS || '{}')
    const account = cozyFields.account

    const token = generateJWT(serviceKey, secretKey)

    log('info', 'Get user...')
    const user = await getOrCreateUser(token, { email, userServiceId: url })
    if (!user) {
      throw new Error('No user found')
    }

    log('info', 'Get purposes...')
    const purposes = await getPurposes(token)
    if (purposes.length < 1) {
      throw new Error('No purpose found')
    }
    const purposeId = purposes[0].id

    log('info', 'Get import info...')
    const popup = await popupImport(token, {
      purpose: purposeId,
      emailImport: email
    })

    const datatypes = popup.datatypes.filter(
      type => type.serviceExport === VENDOR
    )
    const emailExport = popup.emailsExport.find(type => type.service === VENDOR)

    const webhook = await getOrCreateWebhook(account)
    const importUrl = webhook.links.webhook
    log('info', `Webhook available on ${importUrl}`)

    log('info', 'Create import consent...')
    const consent = await createConsent(token, {
      datatypes,
      emailImport: user.email,
      emailExport: emailExport.email,
      serviceExport: VENDOR,
      purpose: purposeId,
      userKey: user.userKey
    })
    log('info', `Got consent : ${consent}`)

    log('info', 'Done!')
  } catch (err) {
    log('error', err && err.message)
    throw new Error(errors.VENDOR_DOWN)
  }
}

const getAccountWebhook = async accountId => {
  const selector = {
    worker: 'konnector',
    type: '@webhook'
  }
  const webhooks = await client.collection('io.cozy.triggers').find(selector)
  return webhooks.data.find(webhook => {
    const msg = webhook.attributes.message
    return msg && msg.account === accountId
  })
}

const getOrCreateWebhook = async accountId => {
  const accountWebhook = await getAccountWebhook(accountId)
  if (!accountWebhook) {
    const newWebhook = await client.collection('io.cozy.triggers').create({
      worker: 'konnector',
      type: '@webhook',
      message: {
        account: accountId,
        konnector: VENDOR.toLowerCase()
      }
    })
    return newWebhook.data
  }
  return accountWebhook
}

const getOrCreateUser = async (token, params) => {
  const { email, userServiceId } = params

  let user
  try {
    user = await request.get(`${baseUrl}/users/${email}`, {
      auth: {
        bearer: token
      }
    })
    if (user) {
      return user
    }
  } catch (err) {
    if (err.statusCode == 400) {
      return request.post(`${baseUrl}/users`, {
        body: { email, userServiceId },
        auth: {
          bearer: token
        }
      })
    }
    throw new Error(err)
  }
}

const getPurposes = async token => {
  return request.get(`${baseUrl}/purposes/list`, {
    auth: {
      bearer: token
    }
  })
}

const popupImport = async (token, params) => {
  const { purpose, emailImport } = params
  return request.post(`${baseUrl}/popups/import`, {
    body: { purpose, emailImport },
    auth: {
      bearer: token
    }
  })
}

const createConsent = async (token, params) => {
  const data = {
    datatypes: params.datatypes,
    emailImport: params.emailImport,
    emailExport: params.emailExport,
    serviceExport: params.serviceExport,
    purpose: params.purpose,
    userKey: params.userKey
  }
  return request.post(`${baseUrl}/consents/exchange/import`, {
    body: data,
    auth: {
      bearer: token
    }
  })
}

const consentImport = async (account, params) => {
  const token = generateJWT(serviceKey, secretKey)
  const { serviceExportUrl, signedConsent } = params
  if (!serviceExportUrl || !signedConsent) {
    throw new Error('Missing parameters')
  }
  console.log('service export url : ', serviceExportUrl)
  const dataImportUrl = 'webhook' // webhook URL
  await request.post(`${serviceExportUrl}`, {
    body: {
      signedConsent,
      dataImportUrl
    },
    auth: {
      bearer: token
    }
  })
}

const generateJWT = (serviceKey, secretKey) => {
  var oHeader = { alg: 'HS256', typ: 'JWT' }
  var payload = {}
  var tNow = KJUR.jws.IntDate.get('now')
  payload.iat = tNow
  payload = {
    serviceKey,
    iat: tNow,
    exp: tNow + 5 * 60
  }
  var sHeader = JSON.stringify(oHeader)
  var sPayload = JSON.stringify(payload)
  var sJWT = KJUR.jws.JWS.sign('HS256', sHeader, sPayload, secretKey)
  return sJWT
}
