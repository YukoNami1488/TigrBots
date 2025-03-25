const { app, BrowserWindow, ipcMain } = require('electron');
const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalNear } = require('mineflayer-pathfinder').goals;
const FlayerCaptcha = require('flayercaptcha');
const readline = require('readline');
const Vec3 = require('vec3');
const fs = require('fs');
const path = require('path');

let botsWindow = null;
let settingsWindow = null;
let farmMenuWindow = null;
let botSettings = {};
const settingsPath = path.join(__dirname, 'settings.cfg');

let currentBot = null;
let intentionalStop = false;

let fishingTimeout = null;
let isFishing = false;
let isHarvesting = false;
let currentCrop = null;

let harvestInterval = null;
let followInterval = null;
let walkInterval = null;
let floodInterval = null;
let statsInterval = null;

function generateRandomNick() {
    const prefix = 'TigrBots_';
    const randomNum = Math.floor(Math.random() * 9999);
    return prefix + randomNum.toString().padStart(4, '0');
}

function createBot(config) {
    return mineflayer.createBot({
        host: config.host,
        port: config.port,
        username: config.nickname,
        hideErrors: true,
        version: config.version || '1.16.5',
        checkTimeoutInterval: 60000
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 600,
        frame: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#2b2b2b',
        transparent: false,
        resizable: true,
        minWidth: 1200,
        minHeight: 600
    });

    win.loadFile('index.html');
    return win;
}

function setupBot(bot, username, window, config) {
    bot.loadPlugin(pathfinder);

    let captchaImages = [];
    let followInterval = null;
    let followTarget = null;

    const log = (message) => {
        window.webContents.send('log', message);
    };

    bot.on('message', (message) => {
        log(message.toString());
        if (botsWindow) {
            botsWindow.webContents.send('bot-message', {
                botId: bot.botId,
                message: message.toString()
            });
        }
    });

    bot.on('spawn', () => {
        try {
            log('Bot spawned');
            window.webContents.send('bot-status', 'connected');

            setTimeout(() => {
                if (bot.entity) {
                    log('Bot fully initialized');
                }
            }, 1000);
        } catch (err) {
            log('Spawn error:', err.message);
        }
    });

    const captcha = new FlayerCaptcha(bot);

    captcha.on('success', async (image, viewDirection) => {
        log(`Captcha detected! Direction: ${viewDirection}`);
        const filename = `captcha_${Date.now()}_${viewDirection}.png`;
        const filePath = path.join(__dirname, 'captchas', filename);

        if (!fs.existsSync(path.join(__dirname, 'captchas'))) {
            fs.mkdirSync(path.join(__dirname, 'captchas'));
        }

        await image.toFile(filePath);
        captchaImages.push(filePath);
        window.webContents.send('new-captcha', filePath);
        log('Captcha saved successfully');
    });

    ipcMain.on('request-captchas', (event) => {
        event.reply('captcha-list', captchaImages);
    });

    bot.on('error', (err) => {
        log('Error:', err.message);
        if (bot.entity) {
            log('Bot still alive, continuing...');
        }
    });

    let floodInterval = null;
    let walkInterval = null;
    let hasClickedMenu = false;
    let selectedServer = null;

    let isHarvesting = false;
    let currentCrop = null;
    let harvestInterval = null;

    ipcMain.on('get-harvesting-status', (event) => {
        event.reply('harvesting-status', isHarvesting, currentCrop);
    });

    async function startFishing() {
        if (isFishing) {
            log('Already fishing!');
            return;
        }

        try {
            const fishingRod = bot.inventory.items().find(item =>
                item.name.includes('fishing_rod')
            );

            if (!fishingRod) {
                log('No fishing rod in inventory!');
                return;
            }

            isFishing = true;
            if (farmMenuWindow && !farmMenuWindow.isDestroyed()) {
                farmMenuWindow.webContents.send('fishing-status', true);
                farmMenuWindow.webContents.send('bot-action', 'Fishing');
            }
            log('Started fishing');

            await bot.equip(fishingRod, 'hand');

            while (isFishing && bot && !bot.isDestroyed) {
                try {
                    await bot.fish();

                    if (farmMenuWindow && !farmMenuWindow.isDestroyed()) {
                        farmMenuWindow.webContents.send('bot-action', 'Fishing');
                    }
                } catch (err) {
                    if (!err.message.includes('fishing') &&
                        !err.message.includes('equipped') &&
                        !err.message.includes('already')) {
                        log('Fishing error:', err.message);
                        stopFishing();
                        return;
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (err) {
            log('Error starting fishing:', err.message);
            stopFishing();
        }
    }

    function stopFishing() {
        if (!isFishing) return;

        isFishing = false;
        if (fishingTimeout) {
            clearTimeout(fishingTimeout);
            fishingTimeout = null;
        }

        if (farmMenuWindow && !farmMenuWindow.isDestroyed()) {
            farmMenuWindow.webContents.send('fishing-status', false);
            farmMenuWindow.webContents.send('bot-action', 'Waiting');
        }
        log('Stopped fishing');
    }

    async function startHarvesting(cropType) {
        if (isHarvesting) {
            log('Harvesting already started!');
            return;
        }

        isHarvesting = true;
        currentCrop = cropType;
        if (farmMenuWindow) {
            farmMenuWindow.webContents.send('harvesting-status', true, cropType);
            farmMenuWindow.webContents.send('bot-action', `Harvesting ${cropType}`);
        }
        log(`Started harvesting ${cropType}`);

        const crops = {
            wheat: ['wheat', 7, 'wheat_seeds'],
            carrot: ['carrots', 7, 'carrot'],
            potato: ['potatoes', 7, 'potato'],
            beetroot: ['beetroots', 7, 'beetroot_seeds'],
            melon: ['melon_block', 0, null],
            pumpkin: ['pumpkin', 0, null],
            sugarcane: ['sugar_cane', 0, 'sugar_cane'],
            cactus: ['cactus', 0, 'cactus']
        };

        const [blockName, growthStage, seedItem] = crops[cropType] || [null, 0, null];
        if (!blockName) {
            log('Unknown crop type!');
            stopHarvesting();
            return;
        }

        harvestInterval = setInterval(async () => {
            try {
                if (!isHarvesting) return;

                const blocks = bot.findBlocks({
                    matching: block => {
                        if (block.name === blockName) {
                            if (growthStage > 0) {
                                return block.metadata >= growthStage;
                            }
                            return true;
                        }
                        return false;
                    },
                    count: 100,
                    maxDistance: 16
                });

                if (blocks.length === 0) return;

                blocks.sort((a, b) => {
                    const distA = bot.entity.position.distanceTo(new Vec3(a.x, a.y, a.z));
                    const distB = bot.entity.position.distanceTo(new Vec3(b.x, b.y, b.z));
                    return distA - distB;
                });

                for (const pos of blocks) {
                    if (!isHarvesting) break;

                    const block = bot.blockAt(pos);
                    if (!block) continue;

                    try {
                        const blockPos = block.position;
                        const distance = bot.entity.position.distanceTo(blockPos);

                        if (distance > 3.5) {
                            bot.lookAt(blockPos.offset(0.5, 0.5, 0.5));
                            bot.setControlState('forward', true);

                            while (bot.entity.position.distanceTo(blockPos) > 3.5 && isHarvesting) {
                                await new Promise(resolve => setTimeout(resolve, 50));
                            }

                            bot.setControlState('forward', false);
                        }

                        await bot.lookAt(blockPos.offset(0.5, 0.5, 0.5));
                        await bot.dig(block);
                        await new Promise(resolve => setTimeout(resolve, 150));

                        if (seedItem) {
                            const seed = bot.inventory.items().find(item => item.name === seedItem);
                            if (seed) {
                                const groundBlock = bot.blockAt(new Vec3(blockPos.x, blockPos.y - 1, blockPos.z));
                                if (groundBlock && (groundBlock.name === 'farmland' ||
                                    (cropType === 'sugarcane' && groundBlock.name === 'grass_block') ||
                                    (cropType === 'cactus' && groundBlock.name === 'sand'))) {
                                    await bot.equip(seed, 'hand');
                                    await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
                                    await new Promise(resolve => setTimeout(resolve, 150));
                                }
                            } else {
                                log('No seeds left in inventory!');
                                stopHarvesting();
                                return;
                            }
                        }

                    } catch (err) {
                        if (!err.message.includes('pathfinding')) {
                            return;
                        }
                    }
                }

            } catch (err) {
                if (!err.message.includes('pathfinding')) {
                    return;
                }
            }
        }, 1000);
    }

    function stopHarvesting() {
        if (!isHarvesting) return;

        isHarvesting = false;
        currentCrop = null;
        if (harvestInterval) {
            clearInterval(harvestInterval);
            harvestInterval = null;
        }
        if (farmMenuWindow) {
            farmMenuWindow.webContents.send('harvesting-status', false);
            farmMenuWindow.webContents.send('bot-action', 'Waiting');
        }
        log('Stopped harvesting');
    }

    ipcMain.on('command', (event, input) => {
        if (!bot || bot.isDestroyed) return;

        if (input === '!fish') {
            startFishing();
        } else if (input === '!unfish') {
            stopFishing();
        } else if (input === '!saveacc') {
            try {
                const accountInfo = `${bot.username}, ${bot.host}\n`;
                fs.appendFileSync('accounts.txt', accountInfo);
                log(`Account ${bot.username} successfully saved to accounts.txt`);
            } catch (err) {
                log('Error saving account:', err.message);
            }
        } else if (input === '!entities') {
            const entities = Object.values(bot.entities);
            if (entities.length === 0) {
                log('No entities nearby');
            } else {
                log('Found entities:');
                entities.forEach(entity => {
                    const distance = bot.entity.position.distanceTo(entity.position).toFixed(2);
                    if (entity.type === 'player') {
                        log(`- Player ${entity.username} at distance ${distance} blocks`);
                    } else {
                        log(`- ${entity.name || entity.displayName || 'Unknown entity'} (type: ${entity.type}) at distance ${distance} blocks`);
                    }
                });
            }
        } else if (input.startsWith('!selectpvp')) {
            const args = input.split(' ');
            const serverNumber = parseInt(args[1]);

            if (!serverNumber || serverNumber < 1 || serverNumber > 3) {
                log('Usage: !selectpvp <server_number> (1-3)');
                return;
            }

            selectedServer = serverNumber;

            const selectPlayer = Object.values(bot.entities).find(entity =>
                entity.type === 'player' && entity.username === 'select'
            );

            if (!selectPlayer) {
                log('Player "select" not found nearby');
                return;
            }

            bot.lookAt(selectPlayer.position)
                .then(() => {
                    bot.setControlState('forward', true);

                    const checkDistance = setInterval(() => {
                        const distance = bot.entity.position.distanceTo(selectPlayer.position);
                        if (distance <= 3) {
                            bot.setControlState('forward', false);
                            clearInterval(checkDistance);

                            bot.attack(selectPlayer);
                            log('Attacking "select" player to open menu');
                        }
                    }, 100);
                });
        } else if (input.startsWith('!hit')) {
            const args = input.split(' ');
            if (args.length < 2) {
                log('Usage: !hit <player_name> [left/right] - default is left click');
                return;
            }

            const targetName = args[1];
            const clickType = args[2]?.toLowerCase() === 'right' ? 'right' : 'left';
            let target = null;

            if (bot.players[targetName]?.entity) {
                target = bot.players[targetName].entity;
            } else {
                target = Object.values(bot.entities).find(entity =>
                    entity.name === targetName || entity.username === targetName
                );
            }

            if (!target) {
                log(`Target "${targetName}" not found nearby`);
                return;
            }

            const distance = bot.entity.position.distanceTo(target.position);

            if (distance > 4) {
                log(`Target is too far (${distance.toFixed(2)} blocks). Need to be within 4 blocks`);
                return;
            }

            (async () => {
                try {
                    await bot.lookAt(target.position.offset(0, target.height * 0.5, 0));

                    if (clickType === 'right') {
                        bot.activateEntity(target);
                        log(`Right clicked ${targetName}`);
                    } else {
                        bot.attack(target);
                        log(`Left clicked ${targetName}`);
                    }
                } catch (err) {
                    log(`Error hitting ${targetName}: ${err.message}`);
                }
            })();
        } else if (input.startsWith('!walk')) {
            const args = input.split(' ');
            if (args.length < 2) {
                log('Usage: !walk <player_name>');
                return;
            }

            const targetName = args[1];
            let target = null;

            if (bot.players[targetName]?.entity) {
                target = bot.players[targetName].entity;
            } else {
                target = Object.values(bot.entities).find(entity =>
                    entity.name === targetName || entity.username === targetName
                );
            }

            if (!target) {
                log(`Target "${targetName}" not found nearby`);
                return;
            }

            const distance = bot.entity.position.distanceTo(target.position);
            log(`Walking to ${targetName} (distance: ${distance.toFixed(2)} blocks)`);

            if (followInterval) {
                clearInterval(followInterval);
                followInterval = null;
                followTarget = null;
            }
            bot.setControlState('forward', false);
            bot.setControlState('sprint', false);

            try {
                const goal = new GoalNear(target.position.x, target.position.y, target.position.z, 2);
                bot.pathfinder.setGoal(goal);

                bot.once('goal_reached', () => {
                    log(`Reached ${targetName}`);
                });
            } catch (err) {
                log(`Error pathfinding to ${targetName}: ${err.message}`);
            }
        } else if (input.startsWith('!follow')) {
            const args = input.split(' ');
            if (args.length < 2) {
                log('Usage: !follow <player_name>');
                return;
            }

            const playerName = args[1];
            const player = bot.players[playerName];

            if (!player || !player.entity) {
                log(`Player ${playerName} not found nearby`);
                return;
            }

            if (followInterval) {
                clearInterval(followInterval);
            }

            followTarget = playerName;
            log(`Following player: ${playerName}`);

            followInterval = setInterval(() => {
                const target = bot.players[followTarget]?.entity;
                if (!target) {
                    log(`Lost sight of ${followTarget}`);
                    clearInterval(followInterval);
                    followInterval = null;
                    followTarget = null;
                    bot.setControlState('forward', false);
                    bot.setControlState('sprint', false);
                    return;
                }

                const distance = bot.entity.position.distanceTo(target.position);

                if (distance > 2) {
                    bot.lookAt(target.position);
                    bot.setControlState('forward', true);
                    bot.setControlState('sprint', true);
                } else {
                    bot.setControlState('forward', false);
                    bot.setControlState('sprint', false);
                }
            }, 50);

        } else if (input === '!stopfollow') {
            if (followInterval) {
                clearInterval(followInterval);
                followInterval = null;
                followTarget = null;
                bot.setControlState('forward', false);
                bot.setControlState('sprint', false);
                log('Stopped following');
            } else {
                log('Not following anyone');
            }
        } else if (input === '!krug') {
            if (walkInterval) {
                log('Bot is already walking in circles');
                return;
            }
            log('Starting circle movement');
            let angle = 0;
            const radius = 2;
            const startPos = bot.entity.position.clone();

            walkInterval = setInterval(() => {
                try {
                    const x = startPos.x + radius * Math.cos(angle);
                    const z = startPos.z + radius * Math.sin(angle);

                    const lookAt = new Vec3(x, bot.entity.position.y, z);
                    bot.lookAt(lookAt);
                    bot.setControlState('forward', true);

                    angle += Math.PI / 32;
                    if (angle >= Math.PI * 2) {
                        angle = 0;
                    }
                } catch (err) {
                    log('Error in movement:', err);
                }
            }, 50);
        } else if (input === '!stopkrug') {
            if (walkInterval) {
                clearInterval(walkInterval);
                walkInterval = null;
                bot.setControlState('forward', false);
                log('Circle movement stopped');
            } else {
                log('Bot is not walking in circles');
            }
        } else if (input === '!inventory') {
            const inventory = bot.inventory.items();
            if (inventory.length === 0) {
                log('Inventory is empty');
            } else {
                log('Inventory contents:');
                inventory.forEach(item => {
                    log(`- ${item.name} (${item.count}) in slot ${item.slot}`);
                });
            }
        } else if (input.startsWith('!drop')) {
            const args = input.split(' ');

            if (args[1] === 'all') {
                const inventory = bot.inventory.items();
                const armor = Object.values(bot.inventory.slots).filter(item =>
                    item && item.slot >= 5 && item.slot <= 8
                );

                if (inventory.length === 0 && armor.length === 0) {
                    log('Inventory is empty and armor is missing');
                    return;
                }

                log('Dropping all items and armor...');

                (async () => {
                    for (const item of armor) {
                        try {
                            await bot.tossStack(item);
                            log(`Dropped ${item.name} (armor) from slot ${item.slot}`);
                        } catch (err) {
                            log(`Error dropping armor from slot ${item.slot}: ${err.message}`);
                        }
                    }

                    for (const item of inventory) {
                        try {
                            await bot.tossStack(item);
                            log(`Dropped ${item.name} (${item.count}) from slot ${item.slot}`);
                        } catch (err) {
                            log(`Error dropping item from slot ${item.slot}: ${err.message}`);
                        }
                    }
                    log('Dropping all items completed');
                })();
                return;
            }

            if (args.length < 2) {
                log('Usage: !drop <slot_number> [count] or !drop all');
                return;
            }

            const slot = parseInt(args[1]);
            const count = args[2] ? parseInt(args[2]) : null;

            const item = bot.inventory.slots[slot];
            if (!item) {
                log(`Item not found in slot ${slot}`);
                return;
            }

            try {
                if (count && count > 0 && count <= item.count) {
                    bot.tossStack(item, count);
                    log(`Dropped ${count} ${item.name} from slot ${slot}`);
                } else {
                    bot.tossStack(item);
                    log(`Dropped all ${item.name} (${item.count}) from slot ${slot}`);
                }
            } catch (err) {
                log('Error dropping item:', err.message);
            }
        } else if (input.startsWith('!harvest')) {
            const args = input.split(' ');
            if (args.length < 2) {
                log('Usage: !harvest <crop_type>');
                return;
            }

            const cropType = args[1];
            startHarvesting(cropType);
        } else if (input === '!stopharvest') {
            stopHarvesting();
        } else {
            bot.chat(input);
        }
    });

    bot.on('windowOpen', async (window) => {
        if (window.title.includes('Выбери сервер!') && !hasClickedMenu && selectedServer) {
            log('Menu for server selection opened');

            window.slots.forEach((item, index) => {
                if (item) {
                    log(`Слот ${index}: ${item.name} (${item.displayName})`);
                }
            });

            const slotMap = {
                1: 10,
                2: 11,
                3: 12
            };

            const slot = slotMap[selectedServer];

            setTimeout(async () => {
                try {
                    await bot.clickWindow(slot, 0, 0);
                    hasClickedMenu = true;
                    log(`Clicked on slot ${selectedServer}-th server (slot ${slot})`);
                } catch (err) {
                    log('Error in click, trying again in 1 second...');
                    setTimeout(async () => {
                        try {
                            await bot.clickWindow(slot, 0, 0);
                            hasClickedMenu = true;
                            log(`Clicked on slot ${selectedServer}-th server (slot ${slot})`);
                        } catch (err) {
                            log('Failed to click on slot:', err.message);
                        }
                    }, 1000);
                }
            }, 1500);
        }
    });

    function updateBotStats() {
        try {
            if (!farmMenuWindow || farmMenuWindow.isDestroyed()) {
                clearInterval(statsInterval);
                statsInterval = null;
                return;
            }

            if (!bot || bot.isDestroyed) {
                clearInterval(statsInterval);
                statsInterval = null;
                return;
            }

            if (bot.entity) {
                const armorPoints = bot.entity.armor ?
                    bot.entity.armor.reduce((total, item) => total + (item ? 2 : 0), 0) : 0;

                farmMenuWindow.webContents.send('bot-stats', {
                    health: bot.health || 0,
                    food: bot.food || 0,
                    armor: armorPoints
                });
            }
        } catch (err) {
            clearInterval(statsInterval);
            statsInterval = null;
        }
    }

    statsInterval = setInterval(updateBotStats, 1000);

    bot.on('end', () => {
        [statsInterval, harvestInterval, fishingTimeout, followInterval, walkInterval, floodInterval].forEach(interval => {
            if (interval) {
                clearInterval(interval);
                clearTimeout(interval);
            }
        });

        statsInterval = null;
        harvestInterval = null;
        fishingTimeout = null;
        followInterval = null;
        walkInterval = null;
        floodInterval = null;

        isFishing = false;
        isHarvesting = false;
        currentCrop = null;

        if (farmMenuWindow && !farmMenuWindow.isDestroyed()) {
            farmMenuWindow.webContents.send('fishing-status', false);
            farmMenuWindow.webContents.send('harvesting-status', false);
            farmMenuWindow.webContents.send('bot-action', 'Disconnected');
            farmMenuWindow.webContents.send('bot-stats', {
                health: 0,
                food: 0,
                armor: 0
            });
        }

        if (window && !window.isDestroyed()) {
            window.webContents.send('bot-status', 'disconnected');
        }

        if (!intentionalStop) {
            log('Disconnected, waiting before reconnect...');
            setTimeout(() => {
                try {
                    let newBot = createBot(config);
                    setupBot(newBot, username, window, config);
                } catch (err) {
                    log('Reconnection error:', err.message);
                    setTimeout(() => {
                        let newBot = createBot(config);
                        setupBot(newBot, username, window, config);
                    }, 10000);
                }
            }, 5000);
        } else {
            intentionalStop = false;
        }
    });

    setInterval(() => {
        if (bot.health !== null) {
            bot.swingArm();
        }
    }, 30000);
}

function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            const data = fs.readFileSync(settingsPath, 'utf8');
            botSettings = JSON.parse(data);
        } else {
            botSettings = {
                host: 'funtime.su',
                port: 25565,
                version: '1.16.5',
                theme: 'dark'
            };
            saveSettings(botSettings);
        }
    } catch (error) {
        console.error('Error loading settings:', error);
        botSettings = {
            host: 'funtime.su',
            port: 25565,
            version: '1.16.5',
            theme: 'dark'
        };
    }
}

function saveSettings(settings) {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

loadSettings();

app.whenReady().then(() => {
    const mainWindow = createWindow();

    ipcMain.on('start-bot', (event, config) => {
        if (currentBot) {
            currentBot.end();
        }

        const bot = createBot(config);
        setupBot(bot, config.nickname, mainWindow, config);
        currentBot = bot;
    });

    ipcMain.on('stop-bot', () => {
        if (currentBot) {
            intentionalStop = true;
            currentBot.end();
            currentBot = null;

            const captchaDir = path.join(__dirname, 'captchas');
            if (fs.existsSync(captchaDir)) {
                fs.readdirSync(captchaDir).forEach(file => {
                    fs.unlinkSync(path.join(captchaDir, file));
                });
            }

            mainWindow.webContents.send('clear-interface');
        }
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    ipcMain.on('clear-captchas', () => {
        const captchaDir = path.join(__dirname, 'captchas');
        if (fs.existsSync(captchaDir)) {
            fs.readdirSync(captchaDir).forEach(file => {
                fs.unlinkSync(path.join(captchaDir, file));
            });
        }
    });

    ipcMain.on('minimize-window', () => {
        mainWindow.minimize();
    });

    ipcMain.on('maximize-window', () => {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    });

    ipcMain.on('close-window', () => {
        mainWindow.close();
    });

    if (typeof global.gc === 'function') {
        setInterval(() => {
            global.gc();
        }, 600000);
    }

    ipcMain.on('open-bots-window', () => {
        if (botsWindow) {
            botsWindow.focus();
            return;
        }

        botsWindow = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            frame: false,
            backgroundColor: '#2b2b2b'
        });

        botsWindow.loadFile('bots.html');

        botsWindow.on('closed', () => {
            botsWindow = null;
        });

        botsWindow.webContents.on('did-finish-load', () => {
            Object.entries(activeBots).forEach(([botId, botInfo]) => {
                botsWindow.webContents.send('bot-created', {
                    id: botId,
                    nickname: botInfo.config.nickname,
                    host: botInfo.config.host,
                    port: botInfo.config.port
                });
            });
        });
    });

    ipcMain.on('request-bot-messages', (event, botId) => {
        if (activeBots[botId] && botsWindow) {
            activeBots[botId].messages.forEach(message => {
                botsWindow.webContents.send('bot-message', {
                    botId: botId,
                    message: message
                });
            });
        }
    });

    ipcMain.on('open-settings', () => {
        if (settingsWindow) {
            settingsWindow.focus();
            return;
        }

        settingsWindow = new BrowserWindow({
            width: 500,
            height: 400,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            resizable: false,
            frame: false,
            backgroundColor: '#2b2b2b'
        });

        settingsWindow.loadFile('settings.html');

        settingsWindow.on('closed', () => {
            settingsWindow = null;
        });
    });

    ipcMain.on('get-settings', (event) => {
        const settings = botSettings || {
            host: 'funtime.su',
            port: 25565,
            version: '1.16.5'
        };
        event.reply('settings-loaded', settings);
        if (!botSettings) {
            botSettings = settings;
            saveSettings(settings);
        }
    });

    ipcMain.on('save-settings', (event, settings) => {
        botSettings = settings;
        saveSettings(settings);

        const windows = [mainWindow, settingsWindow, botsWindow, farmMenuWindow]
            .filter(win => win !== null);

        windows.forEach(win => {
            win.webContents.send('settings-loaded', settings);
            win.webContents.send('theme-changed', settings.theme);
        });
    });

    ipcMain.on('minimize-settings-window', () => {
        if (settingsWindow) {
            settingsWindow.minimize();
        }
    });

    ipcMain.on('minimize-bots-window', () => {
        if (botsWindow) {
            botsWindow.minimize();
        }
    });

    ipcMain.on('reconnect-bot', () => {
        if (currentBot) {
            const config = {
                host: botSettings.host,
                port: botSettings.port,
                nickname: currentBot.username,
                version: botSettings.version
            };

            intentionalStop = true;
            currentBot.end();
            currentBot = null;

            setTimeout(() => {
                const bot = createBot(config);
                setupBot(bot, config.nickname, botsWindow || mainWindow, config);
                currentBot = bot;
                intentionalStop = false;
            }, 1000);
        }
    });

    ipcMain.on('open-farm-menu', () => {
        if (farmMenuWindow) {
            if (!farmMenuWindow.isDestroyed()) {
                farmMenuWindow.focus();
                return;
            }
            farmMenuWindow = null;
        }

        createFarmMenuWindow();
    });

    ipcMain.on('minimize-farm-menu', () => {
        if (farmMenuWindow) {
            farmMenuWindow.minimize();
        }
    });

    ipcMain.on('drop-all-items', async (event) => {
        if (!currentBot) {
            return;
        }

        const inventory = currentBot.inventory.items();
        const armor = Object.values(currentBot.inventory.slots).filter(item =>
            item && item.slot >= 5 && item.slot <= 8
        );

        if (inventory.length === 0 && armor.length === 0) {
            currentBot.emit('message', 'Inventory is empty and armor is missing');
            return;
        }

        currentBot.emit('message', 'Dropping all items and armor...');

        for (const item of armor) {
            try {
                await currentBot.tossStack(item);
                currentBot.emit('message', `Dropped ${item.name} (armor) from slot ${item.slot}`);
            } catch (err) {
                currentBot.emit('message', `Error dropping armor from slot ${item.slot}: ${err.message}`);
            }
        }

        for (const item of inventory) {
            try {
                await currentBot.tossStack(item);
                currentBot.emit('message', `Dropped ${item.name} (${item.count}) in slot ${item.slot}`);
            } catch (err) {
                currentBot.emit('message', `Error dropping item from slot ${item.slot}: ${err.message}`);
            }
        }

        currentBot.emit('message', 'Dropping all items completed');
    });
});

function createFarmMenuWindow() {
    if (farmMenuWindow) {
        if (!farmMenuWindow.isDestroyed()) {
            farmMenuWindow.focus();
            return;
        }
        farmMenuWindow = null;
    }

    farmMenuWindow = new BrowserWindow({
        width: 800,
        height: 500,
        frame: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#2b2b2b',
        resizable: false,
        transparent: false
    });

    farmMenuWindow.loadFile('farm-menu.html');

    farmMenuWindow.webContents.on('did-finish-load', () => {
        if (currentBot && !currentBot.isDestroyed) {
            farmMenuWindow.webContents.send('fishing-status', isFishing);
            farmMenuWindow.webContents.send('harvesting-status', isHarvesting);
            farmMenuWindow.webContents.send('bot-action',
                isFishing ? 'Fishing' :
                    isHarvesting ? `Harvesting ${currentCrop}` :
                        'Waiting'
            );
        }
    });

    farmMenuWindow.on('closed', () => {
        if (statsInterval) {
            clearInterval(statsInterval);
            statsInterval = null;
        }
        farmMenuWindow = null;
    });
}
