const config = require('./config')
const data = require('./data')
const Extra = require('telegraf/extra')
const Markup = require('telegraf/markup')
const urlencode = require('urlencode')
const { text } = config

module.exports = {

    panel: function (ctx) {
        ctx.reply(
            text.hello + ctx.from.id,
            Extra
            .markup(Markup.inlineKeyboard([
            [Markup.urlButton('📨 Condividi link', 't.me/share/url?url=' + urlencode(text.invite + ctx.from.id))],
            [Markup.callbackButton('💵 Portafoglio', 'balance'), Markup.callbackButton('📱 Paypal', 'paypal')],
            [Markup.callbackButton('📜 Regolamento', 'law')],
            [Markup.urlButton('😌 Dicono di noi', data.feedbackURL)],
            [Markup.urlButton('📍 Seguici', data.networkURL)],
            [Markup.urlButton('🌟 Invia un Feedback & Bug report', data.feedbackBot)],
            [Markup.callbackButton('📤 Send Message', 'sendAll')]
            ]))
            .markdown()
            .webPreview(false)
        )
    },
}


