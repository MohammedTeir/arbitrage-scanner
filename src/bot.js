const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require('mongoose');

// Mongoose schema and model setup (assuming User and Top100Coin models are defined in separate files)
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  whitelistIds: { type: [String], default: [] },
  blacklistIds: { type: [String], default: [] },
  marketNamesWhitelist: { type: [String], default: [] },
  isMarketWhitelistedPaused: { type: Boolean, default: true },
  isPaused: { type: Boolean, default: false },
  minProfit: { type: Number, default: 0 },
  minVolume: { type: Number, default: 0 },
  isTop100: { type: Boolean, default: false },
  target: { type: String, default: 'USDT' },
});

const User = mongoose.model('User', userSchema);

const top100CoinsSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  symbol: { type: String, required: true },
  market_cap: { type: Number, required: true },
  last_updated: { type: Date, required: true }
});

const Top100Coin = mongoose.model('Top100Coin', top100CoinsSchema);

// Load environment variables
require("dotenv").config();

// Access environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const PROFIT_THRESHOLD = parseFloat(process.env.PROFIT_THRESHOLD);
const VOLUME_THRESHOLD = parseInt(process.env.VOLUME_THRESHOLD, 10);
const TARGET_CURRENCY = process.env.TARGET_CURRENCY;
const DB_NAME = process.env.DB_NAME;
const TOP100_COINS_URI = process.env.TOP100_COINS_URI;
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// User state tracking
const userState = {};

;


// Connect to MongoDB using Mongoose
async function connectToMongo() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error.message);
    throw error;
  }
}

startBot()

async function getUser(telegramId) {
  try {
    const user = await User.findOne({ telegramId });
    return user;
  } catch (error) {
    console.error("Error fetching user:", error.message);
    return null;
  }
}


// Send a message with error handling and notification to user
async function sendTelegramMessage(chatId, message) {
  if (!chatId) {
    console.error("chat_id is empty or undefined", chatId);
    return;
  }
  try {
    const msg = await bot.sendMessage(chatId, message);
    return msg;
  } catch (error) {
    console.error(`Error sending message to ${chatId}:`, error.message);
    // Notify user of the failure
    try {
      await bot.sendMessage(
        chatId,
        "There was an error sending your message. Please try again later.",
      );
    } catch (notificationError) {
      console.error(
        `Error notifying user of message failure: ${notificationError.message}`,
      );
    }
  }
}

// Fetch coin data including tickers for a specific coin ID

async function fetchCoinData(coinId, chatId) {
  // Check if fetching is paused using Mongoose
  try {
    const user = await getUser(chatId); // Retrieve user data by chatId
    const isPaused = user?.isPaused || false; // Default to false if no value found

    if (isPaused) {
      return null; // Exit the function if paused
    }
  } catch (error) {
    console.error("Error fetching user data:", error.message);
    return null; // Handle potential errors during user data retrieval
  }

  // If not paused, proceed with data fetching (unchanged logic)
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/tickers`;
  const options = {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-cg-demo-api-key": COINGECKO_API_KEY, // Replace with your actual API key if necessary
    },
  };

  try {
    const response = await axios.get(url, options);
    //console.log(`Response for ${coinId}:`, response.data); // Log the response
    return response; // Return the array
  } catch (error) {
    return null;
  }
}


// Format number with commas and currency symbol
function formatVolume(volume) {
  return `$${volume.toLocaleString()}`;
}

async function updateUserTarget(chatId, target) {
  try {
    await User.findOneAndUpdate({ telegramId: chatId }, { $set: { target } }, { upsert: true });
  } catch (error) {
    console.error("Error updating user target:", error.message);
    return null;
  }
}


// Function to check arbitrage opportunities using converted_last.usd for specific pairs with USDT as target
async function checkArbitrage(tickers, chatId) {
  if (!tickers || !tickers.length) {
    return null; // Ensure tickers is not null or empty
  }

  try {
    // Retrieve user data using Mongoose
    const user = await getUser(chatId);

    if (!user) {
      console.error(`User not found with ID: ${chatId}`);
      return null;
    }

    const { minProfit, minVolume, blacklistIds } = user;

    let minPriceTicker = null;
    let maxPriceTicker = null;

    for (const ticker of tickers) {
      if (
        ticker.target === user.target &&
        ticker.volume >= minVolume &&
        ticker.trust_score &&
        !blacklistIds.includes(ticker.base.toLowerCase()) // Exclude blacklisted IDs
      ) {
        const priceUSD = ticker.converted_last?.usd;

        if (priceUSD) {
          minPriceTicker = updateMinPrice(minPriceTicker, ticker, priceUSD);
          maxPriceTicker = updateMaxPrice(maxPriceTicker, ticker, priceUSD);
        }
      }
    }

    if (minPriceTicker && maxPriceTicker) {
      const potentialProfitPercent = calculateProfitPercentage(
        minPriceTicker.converted_last.usd,
        maxPriceTicker.converted_last.usd
      );

      if (potentialProfitPercent < minProfit * 100) return null;

      // Trust score indicator (unchanged logic)
      const trustScoreEmojis = {
        green: "🟢",
        yellow: "🟡",
        red: "🔴",
      };
      const trustScoreEmoji = trustScoreEmojis[minPriceTicker.trust_score] || "";

      return {
        coinPair: `${minPriceTicker.base}/${minPriceTicker.target}`,
        lowestPrice: minPriceTicker.converted_last.usd,
        lowestExchange: minPriceTicker.market.name,
        highestPrice: maxPriceTicker.converted_last.usd,
        highestExchange: maxPriceTicker.market.name,
        volume: formatVolume(minPriceTicker.converted_volume.usd),
        lowestExchangeUrl: minPriceTicker.trade_url,
        highestExchangeUrl: maxPriceTicker.trade_url,
        trustScore: trustScoreEmoji,
        potentialProfit: potentialProfitPercent,
      };
    }

    return null;
  } catch (error) {
    console.error("Error checking arbitrage:", error.message);
    return null;
  }
}

// Helper functions for cleaner logic
function updateMinPrice(currentMin, ticker, priceUSD) {
  return !currentMin || priceUSD < currentMin.converted_last.usd ? ticker : currentMin;
}

function updateMaxPrice(currentMax, ticker, priceUSD) {
  return !currentMax || priceUSD > currentMax.converted_last.usd ? ticker : currentMax;
}

function calculateProfitPercentage(minPrice, maxPrice) {
  return ((maxPrice - minPrice) / minPrice * 100).toFixed(2);
}


// Function to delete a message after a timeout
async function deleteMessage(chatId, messageId, timeout) {
  setTimeout(() => {
    bot
      .deleteMessage(chatId, messageId)
      .catch((err) =>
        console.error(`Failed to delete message: ${err.message}`),
      );
  }, timeout);
}

// Assuming user settings are retrieved from MongoDB
async function getOptions(chatId) {
   
   try {
      const user = await getUser(chatId);

    if (!user) {
      
      await sendTelegramMessage(chatId, "Please Try Again.After Join The Bot");
      return {}; // Or handle the error appropriately
    }

    const { minProfit, minVolume, target, isTop100, isPaused , isMarketWhitelistedPaused } = user;

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕Add to Whitelist", callback_data: "add_coin_id" },
          { text: "➖Remove from Whitelist", callback_data: "remove_coin_id" },
        ],
        [
         { text: "➕Add to Blacklist", callback_data: "add_blacklist_id" },
  { text: "➖Remove from Blacklist", callback_data: "remove_blacklist_id" },
],
[
           {
            text: "📄View Whitelisted IDs",
            callback_data: "view_whitelist",
          },
  { text: "📄View Blacklisted IDs", callback_data: "view_blacklist" }
],
        [
          {
            text: `💸Set Min Profit: ${minProfit*100}%`,
            callback_data: "set_min_profit",
          },
          { text: `🎯Set Target: ${target}`, callback_data: "set_target" }

        ],
        [{
            text: `🔉Set Min Volume: ${minVolume}`,
            callback_data: "set_min_volume",
          }],
        [
          {
            text: `📈Top 100 Coins (Vol): ${isTop100?'Active':'Paused'}`,
            callback_data: "toggle_top100",
          },
        ],
            [
        { text: "➕ Add Market Name", callback_data: "add_market_name" }
        ,
        { text: "❌ Remove Market Name", callback_data: "remove_market_name" } 

    ],
    [
    {
          text: "👁️View Whitelisted Markets",
            callback_data: "view_market_whitelist",
          }
    ],
    
        [
                 
    { text: `⏸️ Markets Whitelist: ${isMarketWhitelistedPaused ? 'Paused' : 'Active'}`, callback_data: "toggle_markets_whitelisting" }
],
 [{ text: `⏸️Fetching is: ${isPaused ? 'Paused' : 'Active'}`, callback_data: "toggle_fetching" }]
 
      ],
    },
  };
}catch (error) {
    console.error("Error fetching user options:", error.message);
    return {}; // Or handle the error appropriately
  }
  }

// Function to handle the /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat && msg.chat.id; // Ensure chatId is defined

  if (!chatId) {
    return;
  }

  try {
    // Check for existing user using Mongoose
    const user = await getUser(chatId);

    let welcomeMessage;
    if (!user) {
      // Create a new user with default settings
      const newUser = new User({
        telegramId: chatId,
        whitelistIds: [],
        blacklistIds: [],
        marketNamesWhitelist: [],
        isMarketWhitelistedPaused: true,
        isPaused: false,
        minProfit: PROFIT_THRESHOLD,
        minVolume: VOLUME_THRESHOLD,
        isTop100: false,
        target: "USDT",
      });
      await newUser.save();

      welcomeMessage = "Welcome to the Arbitrage Bot! You can start by adding trading pairs to your whitelist.";
    } else {
      welcomeMessage = "Welcome back to the Arbitrage Bot! You can check your coins.";
    }

    const welcomeMsgResponse = await sendTelegramMessage(chatId, welcomeMessage);
    deleteMessage(chatId, welcomeMsgResponse.message_id, 5000);

    const options = await getOptions(chatId);
    await bot.sendMessage(chatId, "Choose an option below:", options);
  } catch (error) {
    console.error("Error processing /start command:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
});


//Implement the /options Command

bot.onText(/\/options/, async (msg) => {
  const chatId = msg.chat.id;

  const options = await getOptions(chatId);
  await bot.sendMessage(chatId, "Choose an option below:", options);
});


//Implement the /resume and /pause Commands

bot.onText(/\/resume/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await User.findOneAndUpdate({ telegramId: chatId }, { $set: { isPaused: false } });
    await sendTelegramMessage(chatId, "Fetching data has been resumed.");
  } catch (error) {
    console.error("Error resuming fetching:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
});

bot.onText(/\/pause/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await User.findOneAndUpdate({ telegramId: chatId }, { $set: { isPaused: true } });
    await sendTelegramMessage(chatId, "Fetching data has been paused.");
  } catch (error) {
    console.error("Error pausing fetching:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
});

//Implement the /top100start and /top100stop Commands

bot.onText(/\/top100enable/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await User.findOneAndUpdate({ telegramId: chatId }, { $set: { isTop100: true } });
    await sendTelegramMessage(chatId, "Top 100 coins feature has been enabled.");
  } catch (error) {
    console.error("Error enabling top 100:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
});

bot.onText(/\/top100disable/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await User.findOneAndUpdate({ telegramId: chatId }, { $set: { isTop100: false } });
    await sendTelegramMessage(chatId, "Top 100 coins feature has been disabled.");
  } catch (error) {
    console.error("Error disabling top 100:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
});

bot.onText(/\/view_market_whitelist/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        const user = await User.findOne({ telegramId: chatId });

        if (!user) {
            console.error("User not found for chat ID:", chatId);
            await sendTelegramMessage(chatId, "There was an error. Please try again.");
            return;
        }

        const marketNames = user.marketNamesWhitelist.join("\n");
        await sendTelegramMessage(chatId, `Your whitelisted market names:\n${marketNames}`);
    } catch (error) {
        console.error("Error viewing market whitelist:", error.message);
        await sendTelegramMessage(chatId, "There was an error. Please try again.");
    }
});


// Handle button presses for adding, removing, and viewing coin ids

bot.on("callback_query", async (query) => {
  const { data, message } = query;
  const chatId = message.chat.id;

  if (data === "set_target") {
    // Prompt user to enter the target using sendTelegramMessage
    await sendTelegramMessage(
      chatId,
      "Please enter the target (e.g., USDT, BTC, ETH):",
    );

    // Wait for user input
    bot.once("message", async (msg) => {
      const target = msg.text.trim().toUpperCase();

      // Validate the target input
      if (!target || target.length > 5) {
        // Limit target length for safety
        return await sendTelegramMessage(
          chatId,
          "Invalid target. Please enter a valid target (e.g., USDT, BTC, ETH).",
        );
      }

      // Update the user's document in MongoDB with the new target
      await updateUserTarget(chatId, target);

      const options = await getOptions(chatId);
      await bot.editMessageReplyMarkup(options.reply_markup, {
        chat_id: chatId,
        message_id: message.message_id,
      });

      // Confirmation message
      setTargetMessage = await sendTelegramMessage(
        chatId,
        `Target set to ${target} successfully.`,
      );
      deleteMessage(chatId, setTargetMessage.message_id, 5000);
    });
  }

if (data === "toggle_top100") {
  try {
    const user = await getUser(chatId);
    const newTop100State = !user.isTop100;

    await user.updateOne({ $set: { isTop100: newTop100State } });

    const options = await getOptions(chatId);
    await bot.editMessageReplyMarkup(options.reply_markup, {
      chat_id: chatId,
      message_id: message.message_id,
    });

    const stateMessage = newTop100State ? "enabled" : "disabled";
    const top100Message = await sendTelegramMessage(
      chatId,
      `Top 100 coins feature has been ${stateMessage}.`
    );
    deleteMessage(chatId, top100Message.message_id, 20000);
  } catch (error) {
    console.error("Error toggling top 100:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
}

    if (data === "toggle_markets_whitelisting") {
    try {
      const user = await getUser(chatId);
      user.isMarketWhitelistedPaused = !user.isMarketWhitelistedPaused;
      await user.save();
      
      const options = await getOptions(chatId);
    await bot.editMessageReplyMarkup(options.reply_markup, {
      chat_id: chatId,
      message_id: message.message_id,
    });
    
    // Send a state message
    const stateMessage = user.isMarketWhitelistedPaused ? "paused." :"resumed.";
    const MarketWhitelistFeatureMessage = await sendTelegramMessage(
      chatId,
      `The MarketWhitelist feature has been ${stateMessage}.`
    );
    deleteMessage(chatId, MarketWhitelistFeatureMessage.message_id, 20000);
    
    } catch (error) {
    console.error("Error toggling markets:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
  }


  if (data === "toggle_fetching") {
  try {
    const user = await getUser(chatId);

    if (user) {
      const newFetchingState = !user.isPaused;
      await user.updateOne({ $set: { isPaused: newFetchingState } });

      const options = await getOptions(chatId);
      await bot.editMessageReplyMarkup(options.reply_markup, {
        chat_id: chatId,
        message_id: message.message_id,
      });

      const stateMessage = newFetchingState ? "paused" : "resumed";
      const fetchingDataState = await sendTelegramMessage(
        chatId,
        `Fetching data has been ${stateMessage}.`
      );
      deleteMessage(chatId, fetchingDataState.message_id, 20000);
    } else {
      // Create a new user with default values
      const newUser = new User({
        telegramId: chatId,
        whitelistIds: [],
        blacklistIds: [],
        marketNamesWhitelist: [],
        isMarketWhitelistedPaused: true,
        isPaused: false,
        minProfit: PROFIT_THRESHOLD,
        minVolume: VOLUME_THRESHOLD,
        isTop100: false,
        target: "USDT",
      });
      await newUser.save();
    }
  } catch (error) {
    console.error("Error toggling fetching:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
}

   if (data === "add_coin_id") {
    userState[chatId] = "adding_to_whitelist";
    await sendTelegramMessage(
      chatId,
      "Please send the coin ID you want to add.",
    );
   }
   else if (data === "remove_coin_id") {
    userState[chatId] = "removing_from_whitelist";
    await sendTelegramMessage(
      chatId,
      "Please send the coin ID you want to remove.",
    );
  } else if (data === "view_whitelist") {
  try {
    const user = await getUser(chatId);

    if (user) {
      const whitelistIds = user.whitelistIds.length > 0
        ? user.whitelistIds.join(", ")
        : "No whitelisted coin IDs.";
      await sendTelegramMessage(chatId, `Your whitelisted coin IDs: ${whitelistIds}`);
    } else {
      await sendTelegramMessage(chatId, "You have no whitelisted coin IDs yet.");
    }
  } catch (error) {
    console.error("Error viewing whitelist:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
} else if (data === "add_blacklist_id") {
    userState[chatId] = "adding_to_blacklist";
    await sendTelegramMessage(
      chatId,
      "Please enter the Coin ID you want to blacklist:",
    );

  }else if (data === "remove_blacklist_id") {
    userState[chatId] = "removing_from_blacklist";
    await sendTelegramMessage(
      chatId,
      "Please enter the Coin ID you want to remove from the blacklist:",
    );
  }else if (data === "view_blacklist") {
  try {
    const user = await getUser(chatId);
    const blacklistIds = user?.blacklistIds || [];

    const message = blacklistIds.length > 0
      ? `Your blacklisted IDs: ${blacklistIds.join(", ")}`
      : "Your blacklist is empty.";

    await sendTelegramMessage(chatId, message);
  } catch (error) {
    console.error("Error viewing blacklist:", error.message);
    await sendTelegramMessage(chatId, "There was an error. Please try again.");
  }
}else if (data === 'set_min_profit') {
  const promptMessage = await sendTelegramMessage(chatId, 'Please send the minimum potential profit percentage (e.g., 2 for 2%).');

  bot.once('message', async (msg) => {
    const minProfitPercentage = parseFloat(msg.text);

    if (isNaN(minProfitPercentage) || minProfitPercentage <= 0) {
      await sendTelegramMessage(chatId, 'Please enter a valid profit percentage greater than 0.');
      await deleteMessage(chatId, promptMessage.message_id, 10000);
    } else {
      const minProfit = minProfitPercentage / 100;

      try {
        const user = await getUser(chatId);
        user.minProfit = minProfit;
        await user.save();

        const options = await getOptions(chatId);
        await bot.editMessageReplyMarkup(options.reply_markup, {
          chat_id: chatId,
          message_id: message.message_id
        });

        const confirmationMessage = await sendTelegramMessage(chatId, `Minimum profit percentage set to ${minProfitPercentage}%.`);
        await deleteMessage(chatId, promptMessage.message_id, 10000);
        await deleteMessage(chatId, confirmationMessage.message_id, 10000);
      } catch (error) {
        console.error('Error updating min profit:', error.message);
        await sendTelegramMessage(chatId, 'There was an error saving the minimum profit. Please try again.');
        await deleteMessage(chatId, promptMessage.message_id, 10000);
      }
    }
  });
}
 else if (data === 'set_min_volume') {
  const volumePrompt = await sendTelegramMessage(chatId, 'Please send the minimum 24h volume (e.g., 1000).');

  bot.once('message', async (msg) => {
    const minVolume = parseInt(msg.text, 10);

    if (isNaN(minVolume) || minVolume <= 0) {
      await sendTelegramMessage(chatId, 'Please enter a valid volume greater than 0.');
      await deleteMessage(chatId, volumePrompt.message_id, 10000);
    } else {
      try {
        const user = await getUser(chatId);
        user.minVolume = minVolume;
        await user.save();

        const options = await getOptions(chatId);
        await bot.editMessageReplyMarkup(options.reply_markup, {
          chat_id: chatId,
          message_id: message.message_id
        });

        const volumeConfirmation = await sendTelegramMessage(chatId, `Minimum 24h volume set to ${minVolume}.`);
        await deleteMessage(chatId, volumePrompt.message_id, 10000);
        await deleteMessage(chatId, volumeConfirmation.message_id, 10000);
      } catch (error) {
        console.error('Error updating min volume:', error.message);
        await sendTelegramMessage(chatId, 'There was an error saving the minimum volume. Please try again.');
        await deleteMessage(chatId, volumePrompt.message_id, 10000);
      }
    }
  });
}

if (data === "add_market_name") {
    userState[chatId] = "adding_to_market_whitelist";
    await sendTelegramMessage(
      chatId,
      "Please send the market name you want to add.",
    );
}else if (data === "remove_market_name") {
    userState[chatId] = "removing_from_market_whitelist";
    await sendTelegramMessage(
      chatId,
      "Please send the market name you want to remove."
    );
}

if (data === "view_market_whitelist") {
    const user = await getUser(chatId);

    if (!user) {
        console.error("User not found for chat ID:", chatId);
        await sendTelegramMessage(chatId, "There was an error. Please try again.");
        return;
    }
  
    const marketNames = user.marketNamesWhitelist.length > 0
        ? user.marketNamesWhitelist.join(", ")
        : "No whitelisted markets.";

    await sendTelegramMessage(chatId, `Your whitelisted market names:\n${marketNames}`);
}

});

// Listener for user messages to handle adding and removing coin IDs

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

// Check if the user is in a specific state
 if (userState[chatId] === "adding_to_whitelist") {
  const coinIdToAdd = msg.text.trim();

  try {
    const user = await getUser(chatId);

    if (!user) {
      console.error("User not found for chat ID:", chatId);
      await sendTelegramMessage(chatId, "There was an error. Please try again.");
      return;
    }

    if (user.whitelistIds.includes(coinIdToAdd)) {
      await sendTelegramMessage(chatId, `Coin ID ${coinIdToAdd} is already in your whitelist.`);
    } else {
      user.whitelistIds.push(coinIdToAdd);
      await user.save();
      await sendTelegramMessage(chatId, `Coin ID ${coinIdToAdd} has been added to your whitelist.`);
    }
  } catch (error) {
    console.error("Error adding coin to whitelist:", error.message);
    await sendTelegramMessage(chatId, "There was an error adding the coin ID. Please try again.");
  }

  // Reset the user's state
  delete userState[chatId];
}else if (userState[chatId] === "removing_from_whitelist") {
  const coinIdToRemove = msg.text.trim();

  try {
    const user = await getUser(chatId);

    if (!user) {
      console.error("User not found for chat ID:", chatId);
      await sendTelegramMessage(chatId, "There was an error. Please try again.");
      return;
    }

    if (user.whitelistIds.includes(coinIdToRemove)) {
      user.whitelistIds = user.whitelistIds.filter(id => id !== coinIdToRemove);
      await user.save();
      await sendTelegramMessage(chatId, `Coin ID ${coinIdToRemove} has been removed from your whitelist.`);
    } else {
      await sendTelegramMessage(chatId, `Coin ID ${coinIdToRemove} is not in your whitelist.`);
    }
  } catch (error) {
    console.error("Error removing coin from whitelist:", error.message);
    await sendTelegramMessage(chatId, "There was an error removing the coin ID. Please try again.");
  }

  // Reset the user's state
  delete userState[chatId];
}

 if (userState[chatId] === "adding_to_blacklist") {
  const blacklistId = msg.text.trim().toLowerCase();

  try {
    const user = await getUser(chatId);

    if (!user) {
      console.error("User not found for chat ID:", chatId);
      await sendTelegramMessage(chatId, "There was an error. Please try again.");
      return;
    }

    if (user.blacklistIds.includes(blacklistId)) {
      await sendTelegramMessage(chatId, `${blacklistId} is already in your blacklist.`);
    } else {
      user.blacklistIds.push(blacklistId);
      await user.save();
      await sendTelegramMessage(chatId, `${blacklistId} has been added to your blacklist.`);
    }
  } catch (error) {
    console.error("Error adding coin to blacklist:", error.message);
    await sendTelegramMessage(chatId, "There was an error adding the coin ID to the blacklist. Please try again.");
  }

  delete userState[chatId];
}else if (userState[chatId] === "removing_from_blacklist") {
  const blacklistId = msg.text.trim().toLowerCase();

  try {
    const user = await getUser(chatId);

    if (!user) {
      console.error("User not found for chat ID:", chatId);
      await sendTelegramMessage(chatId, "There was an error. Please try again.");
      return;
    }

    if (user.blacklistIds.includes(blacklistId)) {
      user.blacklistIds = user.blacklistIds.filter(id => id !== blacklistId);
      await user.save();
      await sendTelegramMessage(chatId, `${blacklistId} has been removed from your blacklist.`);
    } else {
      await sendTelegramMessage(chatId, `${blacklistId} is not in your blacklist.`);
    }
  } catch (error) {
    console.error("Error removing coin from blacklist:", error.message);
    await sendTelegramMessage(chatId, "There was an error removing the coin ID from the blacklist. Please try again.");
  }

  delete userState[chatId];
}
    if (userState[chatId] === "adding_to_market_whitelist") {
        const marketNameToAdd = msg.text.trim();

        try {
            const user = await User.findOne({ telegramId: chatId });

            if (!user) {
                console.error("User not found for chat ID:", chatId);
                await sendTelegramMessage(chatId, "There was an error. Please try again.");
                return;
            }

            if (user.marketNamesWhitelist.includes(marketNameToAdd)) {
                await sendTelegramMessage(chatId, `Market name ${marketNameToAdd} is already in your whitelist.`);
            } else {
                user.marketNamesWhitelist.push(marketNameToAdd);
                await user.save();
                await sendTelegramMessage(chatId, `Market name ${marketNameToAdd} has been added to your whitelist.`);
            }
        } catch (error) {
            console.error("Error adding market name to whitelist:", error.message);
            await sendTelegramMessage(chatId, "There was an error adding the market name. Please try again.");
        }

        delete userState[chatId];
    } else if (userState[chatId] === "removing_from_market_whitelist") {
    const marketNameToRemove = msg.text.trim();

    try {
        const user = await User.findOne({ telegramId: chatId });

        if (!user) {
            console.error("User not found for chat ID:", chatId);
            await sendTelegramMessage(chatId, "There was an error. Please try again.");
            return;
        }

        if (user.marketNamesWhitelist.includes(marketNameToRemove)) {
            user.marketNamesWhitelist = user.marketNamesWhitelist.filter(name => name !== marketNameToRemove);
            await user.save();
            await sendTelegramMessage(chatId, `Market name ${marketNameToRemove} has been removed from your whitelist.`);
        } else {
            await sendTelegramMessage(chatId, `Market name ${marketNameToRemove} is not in your whitelist.`);
        }
    } catch (error) {
        console.error("Error removing market name from whitelist:", error.message);
        await sendTelegramMessage(chatId, "There was an error removing the market name. Please try again.");
    }

    delete userState[chatId];
}




    


});

async function checkUserArbitrage(coinId, chatId) {
  const coinData = await fetchCoinData(coinId, chatId);
  const user = await getUser(chatId);
  if (!coinData) {
    return null;
  }

const filteredTickers = user.isMarketWhitelistedPaused
    ? coinData.data.tickers // If paused, use all tickers
    : coinData.data.tickers.filter((ticker) =>
        user.marketNamesWhitelist.includes(ticker.market.name)
      ); // Otherwise, filter based on whitelist
      
  const arbitrageOpportunity = await checkArbitrage(
    filteredTickers,
    chatId,
  );

  if (arbitrageOpportunity) {
    return (
      `💰 <b>Arbitrage Opportunity Found:</b>\n` +
      `🪙 <b>Coin:</b> <b>${coinData.data.name}</b>\n` +
      `🖇️ <b>Coin Pair:</b> ${arbitrageOpportunity.coinPair}\n` +
      `📉 <b>Buy Price:</b> <i>$${arbitrageOpportunity.lowestPrice}</i> on <a href="${arbitrageOpportunity.lowestExchangeUrl}">${arbitrageOpportunity.lowestExchange}</a>\n` +
      `📈 <b>Sell Price:</b> <i>$${arbitrageOpportunity.highestPrice}</i> on <a href="${arbitrageOpportunity.highestExchangeUrl}">${arbitrageOpportunity.highestExchange}</a>\n` +
      `💵 <b>24h Volume:</b> ${arbitrageOpportunity.volume}\n` +
      `📊 <b>Potential Profit:</b> <u>${arbitrageOpportunity.potentialProfit}%</u>\n` +
      `🔒 <b>Trust Score:</b> ${arbitrageOpportunity.trustScore}`
    );
} else {
    return null;
}
}

// Function to check arbitrage for all users
async function checkAllUsersArbitrage() {
  try {
    // Fetch top 100 coins using Mongoose
    const top100Coins = await Top100Coin.find();
    const top100coinsIds = top100Coins.map((coin) => coin.id);

    // Fetch all users using Mongoose
    const users = await User.find();

    for (const user of users) {
      const { telegramId, whitelistIds, isTop100 } = user;

      const coinIds = isTop100 ? top100coinsIds : whitelistIds;

      for (const coinId of coinIds) {
        const message = await checkUserArbitrage(coinId, telegramId);
        // Only send a message if there's a valid arbitrage opportunity
        if (message) {
          await bot.sendMessage(telegramId, message, { parse_mode: "HTML" });
        }
      }
    }
  } catch (error) {
    console.error("Error checking arbitrage for all users:", error.message);
  }
}


async function checkAndCreateTop100CoinsCollection() {
  const collectionName = "top100coins";

  try {
    // Check if the collection exists using Mongoose model
    const collectionExists = await Top100Coin.exists(); // Assuming Top100Coin model is defined

    if (!collectionExists) {
      console.log(
        `Collection ${collectionName} does not exist. Creating and populating it.`,
      );

      // Fetch and insert data using Mongoose model
      await fetchAndInsertTop100Coins();
    } else {
      console.log(`Collection ${collectionName} already exists.`);
    }
  } catch (error) {
    console.error("Error checking top100coins collection:", error.message);
  }
}




// Function to fetch and insert top 100 coins into the collection

async function fetchAndInsertTop100Coins() {
  const url = TOP100_COINS_URI;
  const options = {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-cg-demo-api-key": COINGECKO_API_KEY, // Replace with your actual API key if necessary
    },
  };

  try {
    const response = await axios.get(url, options);
    
    const top100Coins = response.data.map((coin) => ({
      id: coin.id,
      name: coin.name,
      symbol: coin.symbol,
      market_cap: coin.market_cap,
      last_updated: coin.last_updated,
    }));

    // Insert the data using Mongoose model (assuming it's defined elsewhere)
    await Top100Coin.insertMany(top100Coins);
    console.log(
      `${top100Coins.length} coins inserted into top100coins collection.`,
    );
  } catch (apiError) {
    console.error(
      "Error fetching top 100 coins from CoinGecko:",
      apiError.message,
    );
  }
}



async function updateTop100Coins() {
  const url = TOP100_COINS_URI;
  const options = {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-cg-demo-api-key": COINGECKO_API_KEY, // Replace with your actual API key if necessary
    },
  };

  try {
    const response = await axios.get(url, options);
    
    const top100Coins = response.data.map((coin) => ({
      id: coin.id,
      name: coin.name,
      symbol: coin.symbol,
      market_cap: coin.market_cap,
      last_updated: coin.last_updated,
    }));

    // Update the collection using Mongoose
    await Top100Coin.deleteMany({}); // Delete existing documents
    await Top100Coin.insertMany(top100Coins); // Insert new data

    console.log(
      `Top 100 coins updated in the collection. ${top100Coins.length} coins inserted.`,
    );
  } catch (apiError) {
    console.error(
      "Error fetching top 100 coins from CoinGecko for update:",
      apiError.message,
    );
  }
}





async function checkAndCreateUserCollection() {
  try {
  
    // Check if the 'users' collection exists
    const collection = await User.exists(); // Uses Mongoose model

    if (!collection) {
      console.log("Creating 'users' collection with unique index on telegramId.");
      await User.createCollection(); // Uses Mongoose to create collection
    } else {
      console.log("'users' collection already exists.");
    }
  } catch (error) {
    console.error("Error checking/creating 'users' collection:", error.message);
  }
}

// Start the bot and the MongoDB connection
async function startBot() {

  await connectToMongo().catch((error) => {
  console.error("Error connecting to MongoDB:", error.message);
})
 // Check and create collections if they do not exist
  await checkAndCreateUserCollection();
  await checkAndCreateTop100CoinsCollection();
   
  // Schedule to update the top 100 coins every hour
  setInterval(updateTop100Coins, 60 * 60 * 1000); // Update every hour

  // Check for arbitrage opportunities every minute (60000 milliseconds)
  setInterval(checkAllUsersArbitrage, 60000);
  console.log("Arbitrage bot is running...");
}




setInterval(() => {
  const memoryUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  // Memory levels
  const rssMb = memoryUsage.rss / 1024 / 1024;
  const heapTotalMb = memoryUsage.heapTotal / 1024 / 1024;
  const heapUsedMb = memoryUsage.heapUsed / 1024 / 1024;
  const externalMb = memoryUsage.external / 1024 / 1024;

  const rssLevel = rssMb > 100 ? 'High' : rssMb > 50 ? 'Medium' : 'Low';
  const heapUsedLevel = heapUsedMb > (heapTotalMb * 0.8) ? 'High' : heapUsedMb > (heapTotalMb * 0.5) ? 'Medium' : 'Low';

  // CPU levels
  const cpuUserMs = cpuUsage.user / 1000;
  const cpuSystemMs = cpuUsage.system / 1000;
  const cpuLevel = (cpuUserMs + cpuSystemMs) > 200 ? 'High' : (cpuUserMs + cpuSystemMs) > 100 ? 'Medium' : 'Low';

  console.log('--- Memory Usage ---');
  console.log(`RSS: ${rssMb.toFixed(2)} MB (Level: ${rssLevel})`);
  console.log(`Heap Total: ${heapTotalMb.toFixed(2)} MB`);
  console.log(`Heap Used: ${heapUsedMb.toFixed(2)} MB (Level: ${heapUsedLevel})`);
  console.log(`External: ${externalMb.toFixed(2)} MB`);

  console.log('--- CPU Usage ---');
  console.log(`CPU Usage (user): ${cpuUserMs.toFixed(2)} ms`);
  console.log(`CPU Usage (system): ${cpuSystemMs.toFixed(2)} ms`);
  console.log(`Overall CPU Level: ${cpuLevel}`);

},10000); // Log every 10 seconds

/*
module.exports = {
  startBot,
};
*/
