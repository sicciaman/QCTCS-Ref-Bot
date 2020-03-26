const telegraf = require('telegraf')
const config = require('./config')
const data = require('./data')
const rules = require('./rules')
const adminPanel = require('./adminPanel')
const mongo = require('mongodb').MongoClient
const urlencode = require('urlencode')
const Extra = require('telegraf/extra')
const Markup = require('telegraf/markup')
const session = require('telegraf/session')
const Stage = require('telegraf/stage')
const Scene = require('telegraf/scenes/base')
const rateLimit = require('telegraf-ratelimit')
const { text } = config
const bot = new telegraf(data.token, {telegram: {webhookReply: false}})
let db;
let sub_user;
let firstStart = false;
let timerCheckout = false;

const buttonsLimit = {
  window: 1000,
  limit: 1,
  onLimitExceeded: (ctx, next) => {
    if ('callback_query' in ctx.update)
    ctx.answerCbQuery('You`ve pressed buttons too oftern, wait.', true)
      .catch((err) => sendError(err, ctx))
  },
  keyGenerator: (ctx) => {
    return ctx.callbackQuery ? true : false
  }
}
bot.use(rateLimit(buttonsLimit))


mongo.connect(data.mongoLink, {useNewUrlParser: true, useUnifiedTopology: true}, (err, client) => {
  if (err) {
    sendError(err)
  }

  db = client.db('refbot')
  bot.startWebhook('/refbot', null, 2104)
  bot.startPolling()
})


const stage = new Stage()
bot.use(session())
bot.use(stage.middleware())

const getPaypal = new Scene('getPaypal')
stage.register(getPaypal)

const messageAll = new Scene('messageAll')
stage.register(messageAll)

bot.hears(/^\/start (.+[1-9]$)/, async (ctx) => {
  try {
    sub_user = true;
    let inv = true;
    checkSub(ctx, inv);
  } catch (err) {
    sendError(err, ctx)
  }
})

bot.start(async (ctx) => {
  try {
    sub_user = true;
    let inv = false;
    if (data.admins.includes(ctx.from.id.toString())) {
      adminPanel.panel(ctx);
    } else {
      checkSub(ctx, inv);
    }   
  } catch (err) {
    sendError(err, ctx)
  }
})

// Imposta il totale erogabile dal bot (es. /setCash 200) - Funzione riservata agli admin
bot.hears(/^\/setCash (.+[0-9]$)/, async (ctx) => {
  try {
    if (data.admins.includes(ctx.from.id.toString())) {
      let cashAmount = await db.collection('availableCash').find({label: 'tot'}).toArray()
      if ( cashAmount.length === 0) {
        db.collection('availableCash').insertOne({label: 'tot', total: +ctx.match[1]});
        bot.telegram.sendMessage(ctx.from.id, 'Totale impostato')
      }
      else {
        db.collection('availableCash').updateOne({label: 'tot'}, {$set: {total: +ctx.match[1]}});
        bot.telegram.sendMessage(ctx.from.id, 'Totale aggiornato')
      }
    }
  } catch (err) {
    sendError(err, ctx)
  }
})

bot.action('main', async (ctx) => {
  ctx.answerCbQuery()
  ctx.scene.leave('getPaypal')

  ctx.editMessageText(
    text.hello + ctx.from.id,
    Extra
    .markup(Markup.inlineKeyboard([
      [Markup.urlButton('📨 Condividi link', 't.me/share/url?url=' + urlencode(text.invite + ctx.from.id))],
      [Markup.callbackButton('💵 Portafoglio', 'balance'), Markup.callbackButton('📱 Paypal', 'paypal')],
      [Markup.callbackButton('📜 Regolamento', 'law')],
      [Markup.urlButton('😌 Dicono di noi', data.feedbackURL)],
      [Markup.urlButton('📍 Seguici', data.networkURL)],
      [Markup.urlButton('🌟 Invia un Feedback & Bug report', data.feedbackBot)]
    ]))
    .markdown()
    .webPreview(false)
  )
    .catch((err) => sendError(err, ctx))
})

async function setTimer (ctx) {
    try {
      let today = new Date();
      let day = today.getDay();

      if(day === data.checkoutDay) {

        let validInv = [];
        let notPaid = await db.collection('allUsers').find({inviter: ctx.from.id, paid: false}).toArray(); // only not paid invited users
        let thisUsersData = await db.collection('allUsers').find({userId: ctx.from.id}).toArray();
        let sum;

        for (let k = 0; k < notPaid.length; k++) {
          let userInv = notPaid[k];
          console.log(userInv)
          let subYet = true;
          for (let i = 0; i < data.nChan; i++) {
            let res = await bot.telegram.getChatMember(data.channels[i], userInv.userId);
            console.log(res)
            if(!['creator', 'administrator', 'member'].includes(res.status.toString())) {
              subYet = false;
              db.collection('allusers').remove({userId: userInv.userId, paid: false})
              .catch((err) => sendError(err, ctx))
            }
          }
          if (subYet) {
            validInv.push(userInv);
          }
        }

        sum = validInv.length * data.eur4usr10;
        
        if (sum >= data.eur4usr10 * data.minInv) {
          timerCheckout = true;
          bot.telegram.sendMessage(ctx.from.id, 'Finalmente puoi richiedere il pagamento! Vai nella sezione Portafoglio e clicca su Ritira', 
            Extra
            .markup(Markup.inlineKeyboard([
              [Markup.callbackButton('🏠 Home', 'main')]
            ]))
            .markdown()
            .webPreview(false)
          )
        } else {
          timerCheckout = false;
          bot.telegram.sendMessage(ctx.from.id, 'Potresti ritirare ma alcuni invitati sono usciti anticipatamente dai canali! Accertati che facciano ancora parte per poter richiedere il pagamento!', 
            Extra
            .markup(Markup.inlineKeyboard([
              [Markup.callbackButton('🏠 Home', 'main')]
            ]))
            .markdown()
            .webPreview(false)
          )
        }
      }
    } catch (err) {
      sendError(err, ctx)
    }
}


bot.action('balance', async (ctx) => {
  try {
    ctx.answerCbQuery()
    let notPaid = await db.collection('allUsers').find({inviter: ctx.from.id, paid: false}).toArray() // only not paid invited users
    let thisUsersData = await db.collection('allUsers').find({userId: ctx.from.id}).toArray()
    let availableCash = await db.collection('availableCash').find({label: 'tot'}).toArray()
    let sum, payments;
    let validInv = [];
    let inlineKeyboard;

    for (let k = 0; k < notPaid.length; k++) {
      let userInv = notPaid[k];
      console.log(userInv)
      let subYet = true;
      for (let i = 0; i < data.nChan; i++) {
        let res = await bot.telegram.getChatMember(data.channels[i], userInv.userId);
        console.log(res)
        if(!['creator', 'administrator', 'member'].includes(res.status.toString())) {
          subYet = false;
          db.collection('allusers').remove({userId: userInv.userId, paid: false})
          .catch((err) => sendError(err, ctx))
        }
      }
      if (subYet) {
        validInv.push(userInv);
      }
    }

    let allRefs = await db.collection('allUsers').find({inviter: ctx.from.id}).toArray() // all invited users

    sum = validInv.length * data.eur4usr10;

    if (thisUsersData[0].payments === 0) {
      payments = ''
    } else {
      payments = '\n\nFinora hai ricevuto un totale di: *' + thisUsersData[0].payments + ' monete*!'
    }

    
    if (sum >= data.eur4usr10 * data.minInv && timerCheckout === false) {
      bot.telegram.sendMessage(ctx.from.id, '❗️ *Hai raggiunto il numero minimo di invitati!*\n\n *Attendi il lunedì per poter chiedere il ritiro!* Assicurati che tutti i tuoi amici *siano ancora membri*!\n\n Verrai notificato quando potrai procedere!',
        Extra
        .markup(Markup.inlineKeyboard([
          [Markup.callbackButton('🏠 Home', 'main')]
        ]))
        .markdown()
        .webPreview(false)
      )
      setTimer(ctx);
    }

    if (timerCheckout === true) {
      inlineKeyboard = Markup.inlineKeyboard([
        [Markup.callbackButton('◀️ Back', 'main'), Markup.callbackButton('🔍 Lista invitati', 'invited')],
        [Markup.callbackButton('💸 Ritira', 'withdraw')]
      ]);
    } else {
      inlineKeyboard = Markup.inlineKeyboard([
        [Markup.callbackButton('◀️ Back', 'main'), Markup.callbackButton('🔍 Lista invitati', 'invited')]
      ]);
    }
    
    ctx.editMessageText(
      'Il tuo bilancio è di: *' + sum + ' monete*.\n\nIl totale di persone invitate è: *' + validInv.length + ' *(' + allRefs.length + ' totali)' + payments + '\nSaldo erogabile dal bot: *' + availableCash[0].total + ' monete*',
      Extra
      .markup(inlineKeyboard)
      .markdown()
    )
      .catch((err) => sendError(err, ctx))
  } catch (err) {
    sendError(err, ctx)
  }
})

bot.action('law', async (ctx) => {
  try {
    ctx.editMessageText(
      rules.rules,
      Extra
      .markup(Markup.inlineKeyboard([
        [Markup.callbackButton('◀️ Back', 'main')]
      ]))
      .markdown()
    )
      .catch((err) => sendError(err, ctx))
  } catch (err) {
    sendError(err, ctx)
  }
})

async function checkInv (ctx) {
  let listInvNotPaid = await db.collection('allUsers').find({inviter: ctx.from.id, paid: false}).toArray();
  let listInvPaid = await db.collection('allUsers').find({inviter: ctx.from.id, paid: true}).toArray();
  let message = `Questa è la tua lista invitati: \n\n*N.B.*\n✅ *Utenti da pagare*\n❌ *Utenti che sono già stati pagati*\n\n`;
  
  if (listInvNotPaid.length !== 0) {
    listInvNotPaid.forEach(element => {
      message = message + "✅ " + element.name.toString() + "\n"
    });
  }

  if (listInvPaid.length !== 0) {
    listInvPaid.forEach(element => {
      message = message + "❌ " + element.name.toString() + "\n"
    });
  }
  return message;
}

bot.action('invited', async(ctx) => {
  try {
    let message = await checkInv(ctx)

    ctx.editMessageText(
      message,
      Extra
      .markup(Markup.inlineKeyboard([
        [Markup.callbackButton('◀️ Back', 'balance')]
      ]))
      .markdown()
    )
      .catch((err) => sendError(err, ctx))
  } catch (err) {
    sendError(err, ctx)
  }
})

bot.action('withdraw', async (ctx) => {
  try {
    if (timerCheckout) {
      ctx.answerCbQuery();
      let currentUser = await db.collection('allUsers').find({userId: ctx.from.id}).toArray();
      let listInvNotPaid = await db.collection('allUsers').find({inviter: ctx.from.id, paid: false}).toArray();
      let sum;
      sum = listInvNotPaid.length * data.eur4usr10;
      
      if (!('paypal' in currentUser[0])) {
        return ctx.editMessageText(
          'Non hai ancora aggiunto il tuo indirizzo Paypal.',
          Extra
          .markup(Markup.inlineKeyboard([
            [Markup.callbackButton('🏠 Home', 'main')],
            [Markup.callbackButton('💵 Portafoglio', 'balance'), Markup.callbackButton('📱 Paypal', 'paypal')],
          ]))
          .webPreview(false)
        )
        .catch((err) => sendError(err, ctx))
      }
      
      timerCheckout = false;
      ctx.editMessageText(
        '✅ La tua richiesta è stata *accettata*!\n\n Riceverai un messaggio non appena il pagamento sarà stato emesso.', 
        Extra
        .markup(Markup.inlineKeyboard([
          [Markup.callbackButton('◀️ Home', 'main')]
        ]))
        .markdown()
      )
      .catch((err) => sendError(err, ctx))
        
      data.admins.forEach((adm) => {
        bot.telegram.sendMessage( // send message to admin
          adm,
          'New request. \nUser: [' + ctx.from.first_name + '](tg://user?id=' + ctx.from.id + ')\n' + 
          'ID: ' + ctx.from.id + '\n' +
          'Totale: ' + sum + ' monete 💰 \nPaypal: ' + currentUser[0].paypal,
          Extra
          .markup(Markup.inlineKeyboard([
            [Markup.callbackButton('✅ Paid', 'paid_' + ctx.from.id)]
          ]))
        )
        .catch((err) => sendError(err, ctx))
      })
       
      for (let key of listInvNotPaid) {
        db.collection('allUsers').updateOne({userId: key.userId}, {$set: {paid: true}}, {upsert: true}) // mark refs as paid
          .catch((err) => sendError(err, ctx))
      }

      db.collection('allUsers').updateOne({userId: ctx.from.id}, {$set: {payments: currentUser[0].payments + sum}}, {upsert: true})
        .catch((err) => sendError(err, ctx))

      let botCash = await db.collection('availableCash').find({label: 'tot'}).toArray();
      db.collection('availableCash').updateOne({label: 'tot'}, {$set: {total: botCash[0].total - sum}})
        .catch((err) => sendError(err, ctx))
    }
   } catch (err) {
    sendError(err, ctx)
  }
})

bot.action(/paid_[1-9]/, async (ctx) => {
  try {
    ctx.answerCbQuery()
    let userId = ctx.update.callback_query.data.substr(5)
  
    ctx.editMessageText(ctx.update.callback_query.message.text + '\n\n✅ Paid')
      .catch((err) => sendError(err, ctx))
    bot.telegram.sendMessage(userId, 'La tua richiesta è stata *pagata*. Controlla il tuo account Paypal!',
      Extra
      .markup(Markup.inlineKeyboard([
        [Markup.callbackButton('🏠 Home', 'main')]
      ]))
      .markdown()
      .webPreview(false)
    )
      .catch((err) => sendError(err, ctx))
  } catch (err) {
    sendError(err, ctx)
  }
})


bot.action('paypal', async (ctx) => {
  try {
    ctx.answerCbQuery()
    let dbData = await db.collection('allUsers').find({userId: ctx.from.id}).toArray()
    
    if ('paypal' in dbData[0]) {
      ctx.editMessageText(
        'Il tuo indirizzo: ' + dbData[0].paypal + '\n❗️ Assicurati sia giusto! Riceverai il pagamento direttamento sul tuo account.',
        Extra
        .markup(Markup.inlineKeyboard([
          [Markup.callbackButton('◀️ Back', 'main'), Markup.callbackButton('🖊 Modifica', 'get_paypal')]
        ])) 
        )
          .catch((err) => sendError(err, ctx))
    } else {
      ctx.editMessageText(
        'Ancora non hai aggiunto il tuo indirizzo Paypal.',
        Extra
        .markup(Markup.inlineKeyboard([
          [Markup.callbackButton('◀️ Back', 'main'), Markup.callbackButton('🖊 Aggiungi Paypal', 'get_paypal')]
        ]))
      )
        .catch((err) => sendError(err, ctx))
    }
  } catch (err) {
    sendError(err, ctx)
  }
  
})

bot.action('get_paypal', async (ctx) => {
  try {
    ctx.answerCbQuery()
    ctx.scene.enter('getPaypal')
  
    ctx.editMessageText(
      'Inserisci il tuo indirizzo nella forma mariorossi@gmail.com:',
      Extra
      .markup(Markup.inlineKeyboard([
        [Markup.callbackButton('◀️ Annulla', 'paypal')]
      ]))
      )
        .catch((err) => sendError(err, ctx))
  } catch (err) {
    sendError(err, ctx)
  }
})

getPaypal.hears(/^/,async (ctx) => { 
  ctx.reply('Il tuo indirizzo: ' + ctx.message.text,
    Extra
    .markup(Markup.inlineKeyboard([
      [Markup.callbackButton('◀️ Back', 'main'), Markup.callbackButton('🖊 Edit', 'get_paypal')]
    ]))
  )
    .catch((err) => sendError(err, ctx))

  db.collection('allUsers').updateOne({userId: ctx.from.id}, {$set: {paypal: ctx.message.text}}, {upsert: true})
  .catch((err) => sendError(err, ctx))
  ctx.scene.leave('getPaypal')
})



bot.action('sendAll', async (ctx) => {
  try {
    ctx.answerCbQuery()
    ctx.scene.enter('messageAll')
  
    ctx.editMessageText(
      'Invia il messaggio da inoltrare a tutti i membri del BOT!',
      Extra
      .markup(Markup.inlineKeyboard([
        [Markup.callbackButton('◀️ Annulla', 'main')]
      ]))
      )
        .catch((err) => sendError(err, ctx))
  } catch (err) {
    sendError(err, ctx)
  }
})

messageAll.hears(/^/,async (ctx) => { 
  ctx.reply('Messaggio inviato:\n\n' + ctx.message.text,
    Extra
    .markup(Markup.inlineKeyboard([
      [Markup.callbackButton('◀️ Back', 'main')]
    ]))
  )
    .catch((err) => sendError(err, ctx))

  let usersList = await db.collection('allUsers').find().toArray()
    .catch((err) => sendError(err, ctx))
  usersList.forEach((usr) => {
    bot.telegram.sendMessage(usr.userId, '⚠️ *Messaggio dagli admin*:\n\n' + ctx.message.text,
        Extra
          .markup(Markup.inlineKeyboard([
            [Markup.callbackButton('🏠 Home', 'main')]
          ]))
          .markdown()
          .webPreview(false)
      )
      .catch((err) => sendError(err, ctx))
  })
  ctx.scene.leave('messageAll')
})

/*
bot.command('getmembers', async (ctx) => {
  if (data.admins.includes(ctx.from.id)) {
    try {
      let dbData = await db.collection('allUsers').find({}).toArray()
      ctx.reply('🌀 All users: ' + dbData.length)
    } catch (err) {
      sendError(err, ctx)
    }
  }
})
*/


async function checkSub(ctx, inv) {
  console.log(ctx.from);
  // Ritrova l'utente corrente dal DB
  let dbData = await db.collection('allUsers').find({userId: ctx.from.id}).toArray()
  // Se è la prima volta che l'utente avvia il bot
  if (dbData.length === 0) {
    // Viene messa a TRUE la variabile che indica che è la prima volta che lo avvia e viene aggiunto alla lista degli utenti nel DB
    firstStart = true;
    if (inv) {
      db.collection('allUsers').insertOne({userId: ctx.from.id, name: ctx.from.first_name, inviter:+ctx.match[1], paid: false, payments: 0});
      bot.telegram.sendMessage(+ctx.match[1], '⭐️ Complimenti!\n\n' +  ctx.from.first_name + ' ha usato il tuo link referral!',
        Extra
          .markup(Markup.inlineKeyboard([
            [Markup.callbackButton('🏠 Home', 'main')]
          ]))
          .webPreview(false)
      )
      .catch((err) => sendError(err, ctx))
    } else {
      db.collection('allUsers').insertOne({userId: ctx.from.id, name: ctx.from.first_name, inviter: 0, paid: true, payments: 0});
    }
  } 
  // Loop che controlla che l'utente sia un membro effettivo di tutti i canali in cui è richiesta l'iscrizione
  for(let i=0; i<data.nChan; i++) {
    let res;
    console.log(ctx.from.id);
    res = await bot.telegram.getChatMember(data.channels[i], ctx.from.id);
    console.log(res)
    if(!['creator', 'administrator', 'member'].includes(res.status.toString())) {
      sub_user = false;
    }
  }

  // Se l'utente invitato era già membro dei canali
  if (firstStart && sub_user) {
    db.collection('allUsers').updateOne({userId: ctx.from.id}, { $set: {
                                                                  inviter: 0,
                                                                  paid: true
                                                                  }
                                                                });
  }

  // Se è effettivamente già membro, mostriamo la "home" del bot
  if(sub_user) {
    ctx.reply(
      text.hello + ctx.from.id,
      Extra
      .markup(Markup.inlineKeyboard([
        [Markup.urlButton('📨 Condividi link', 't.me/share/url?url=' + urlencode(text.invite + ctx.from.id))],
        [Markup.callbackButton('💵 Portafoglio', 'balance'), Markup.callbackButton('📱 Paypal', 'paypal')],
        [Markup.callbackButton('📜 Regolamento', 'law')],
        [Markup.urlButton('😌 Dicono di noi', data.feedbackURL)],
        [Markup.urlButton('📍 Seguici', data.networkURL)],
        [Markup.urlButton('🌟 Invia un Feedback & Bug report', data.feedbackBot)]
      ]))
      .markdown()
      .webPreview(false)
    )
  
  // Se l'utente non è ancora un membro dei canali
  } else {
    ctx.reply(
      text.not_sub,
      Extra
      .markup(Markup.inlineKeyboard([
        [Markup.urlButton('🐧 CANALE 1', data.channel_link_1)],
        [Markup.urlButton('🦄 CANALE 2', data.channel_link_2)], 
        [Markup.urlButton('🇨🇳 CANALE 3', data.channel_link_3)]
      ]))
      .markdown()
      .webPreview(false)
    )
  }
  // Risettiamo la variabile al valore di default
  firstStart = false;
}


async function sendError(err, ctx) {
  console.log(err.toString())
  if (ctx != undefined) {
    if (err.code === 400) {
      return setTimeout(() => {
        ctx.answerCbQuery()
        ctx.editMessageText(
          text.hello + ctx.from.id,
          Extra
          .markup(Markup.inlineKeyboard([
            [Markup.urlButton('📨 Condividi link', 't.me/share/url?url=' + urlencode(text.invite + ctx.from.id))],
            [Markup.callbackButton('💵 Portafoglio', 'balance'), Markup.callbackButton('📱 Paypal', 'paypal')],
            [Markup.callbackButton('📜 Regolamento', 'law')],
            [Markup.urlButton('😌 Dicono di noi', data.feedbackURL)],
            [Markup.urlButton('📍 Seguici', data.networkURL)],
            [Markup.urlButton('🌟 Invia un Feedback & Bug report', data.feedbackBot)]
          ]))
          .markdown()
          .webPreview(false)
        )
      }, 500)
    } else if (err.code === 429) {
      return ctx.editMessageText(
        'You`ve pressed buttons too often and were blocked by Telegram' +
        'Wait some minutes and try again'
      )
    }

    data.admins.forEach((adm) => {
      bot.telegram.sendMessage(adm, '[' + ctx.from.first_name + '](tg://user?id=' + ctx.from.id + ') has got an error.\nError text: ' + err.toString(), {parse_mode: 'markdown'})
    })
  } else {
    data.admins.forEach((adm) => {
      bot.telegram.sendMessage(adm, 'There`s an error:' + err.toString())
    })
  }
}

bot.catch((err) => {
  sendError(err)
})

process.on('uncaughtException', (err) => {
  sendError(err)
})