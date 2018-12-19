require('dotenv').config();
require('./models');
import fs from 'fs';
import path from 'path';
import Telegraf, { ContextMessageUpdate } from 'telegraf';
import TelegrafI18n, { match } from 'telegraf-i18n';
import Stage from 'telegraf/stage';
import session from 'telegraf/session';
import mongoose from 'mongoose';
import rp from 'request-promise';
import User from './models/User';
import logger from './util/logger';
import about from './controllers/about';
import startScene from './controllers/start';
import searchScene from './controllers/search';
import moviesScene from './controllers/movies';
import settingsScene from './controllers/settings';
import { checkUnreleasedMovies } from './util/notifier';
import asyncWrapper from './util/error-handler';
import { getMainKeyboard } from './util/keyboards';
import { updateLanguage } from './util/language';
import { updateUserTimestamp } from './middlewares/update-user-timestamp';
import { getUserInfo } from './middlewares/user-info';

mongoose.connect(
  `mongodb://localhost:27017/${process.env.DATABASE_HOST}`,
  { useNewUrlParser: true, useFindAndModify: false }
);
mongoose.connection.on('error', err => {
  logger.error(
    undefined,
    `Error occured during an attempt to establish connection with the database: %O`,
    err
  );
  process.exit(1);
});

mongoose.connection.on('open', () => {
  const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
  const stage = new Stage([startScene, searchScene, moviesScene, settingsScene]);
  const i18n = new TelegrafI18n({
    defaultLanguage: 'en',
    directory: path.resolve(__dirname, 'locales'),
    useSession: true,
    allowMissing: false,
    sessionName: 'session'
  });

  bot.context.userInfo = {
    language: undefined
  };

  bot.use(session());
  bot.use(i18n.middleware());
  bot.use(stage.middleware());
  bot.use(getUserInfo);

  bot.command('saveme', async (ctx: ContextMessageUpdate) => {
    logger.debug(ctx, 'User uses /saveme command');

    const { mainKeyboard } = getMainKeyboard(ctx);
    await ctx.reply(ctx.i18n.t('shared.what_next'), mainKeyboard);
  });
  bot.start(asyncWrapper(async (ctx: ContextMessageUpdate) => ctx.scene.enter('start')));
  bot.hears(
    match('keyboards.main_keyboard.search'),
    updateUserTimestamp,
    asyncWrapper(async (ctx: ContextMessageUpdate) => await ctx.scene.enter('search'))
  );
  bot.hears(
    match('keyboards.main_keyboard.movies'),
    updateUserTimestamp,
    asyncWrapper(async (ctx: ContextMessageUpdate) => await ctx.scene.enter('movies'))
  );
  bot.hears(
    match('keyboards.main_keyboard.settings'),
    updateUserTimestamp,
    asyncWrapper(async (ctx: ContextMessageUpdate) => await ctx.scene.enter('settings'))
  );
  bot.hears(match('keyboards.main_keyboard.about'), updateUserTimestamp, asyncWrapper(about));
  bot.hears(
    match('keyboards.back_keyboard.back'),
    asyncWrapper(async (ctx: ContextMessageUpdate) => {
      // If this method was triggered, it means that bot was updated when user was not in the main menu..
      logger.debug(ctx, 'Return to the main menu with the back button');
      const { mainKeyboard } = getMainKeyboard(ctx);

      await ctx.reply(ctx.i18n.t('shared.what_next'), mainKeyboard);
    })
  );

  bot.hears(/(.*?)/, async (ctx: ContextMessageUpdate) => {
    logger.debug(ctx, 'Default handler has fired');
    const user = await User.findById(ctx.from.id);
    await updateLanguage(ctx, user.language);

    const { mainKeyboard } = getMainKeyboard(ctx);
    await ctx.reply(ctx.i18n.t('other.default_handler'), mainKeyboard);
  });

  bot.catch((error: any) => {
    logger.error(undefined, 'Global error has happened, %O', error);
  });

  setInterval(checkUnreleasedMovies, 86400000);

  process.env.NODE_ENV === 'production' ? startProdMode(bot) : startDevMode(bot);
});

function startDevMode(bot: Telegraf<ContextMessageUpdate>) {
  logger.debug(undefined, 'Starting a bot in development mode');

  rp(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/deleteWebhook`).then(() =>
    bot.startPolling()
  );
}

async function startProdMode(bot: Telegraf<ContextMessageUpdate>) {
  logger.debug(undefined, 'Starting a bot in production mode');
  const tlsOptions = {
    key: fs.readFileSync('/etc/letsencrypt/live/dmbaranov.io/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/dmbaranov.io/fullchain.pem')
  };

  await bot.telegram.setWebhook(`https://dmbaranov.io:8443/${process.env.TELEGRAM_TOKEN}`, {
    source: 'cert.pem'
  });

  bot.startWebhook(`/${process.env.TELEGRAM_TOKEN}`, tlsOptions, +process.env.WEBHOOK_PORT);
  checkUnreleasedMovies();
}
