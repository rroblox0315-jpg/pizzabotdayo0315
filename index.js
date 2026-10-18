import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from 'discord.js';
import { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus, 
    EndBehaviorType, 
    getVoiceConnection 
} from '@discordjs/voice';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as googleTTS from 'google-tts-api';
import prism from 'prism-media';
import fs from 'fs';
import path from 'path';
import http from 'http';
import 'dotenv/config';

// --- 1. Webサーバー (Renderスリープ防止用) ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running 24/7!');
}).listen(PORT, () => {
    console.log(`🌐 Keep-alive server listening on port ${PORT}`);
});

// --- 2. 初期設定 ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const player = createAudioPlayer();

const TEMP_USER_AUDIO = path.resolve('./temp_user.wav');

// --- 3. スラッシュコマンド定義 ---
const commands = [
    new SlashCommandBuilder().setName('join').setDescription('VCに参加してGemini AIと会話を開始します'),
    new SlashCommandBuilder().setName('leave').setDescription('VCから退室します')
];

client.once('ready', async () => {
    console.log(`✅ ログイン完了: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        const guilds = client.guilds.cache.map(g => g.id);
        for (const guildId of guilds) {
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, guildId),
                { body: commands }
            );
        }
        console.log(`⚡ 全 ${guilds.length} 個のサーバーにスラッシュコマンドを【即時同期】しました！`);
    } catch (error) {
        console.error('❌ コマンド登録エラー:', error);
    }
});

// --- 4. コマンド処理 ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, member, guild } = interaction;

    if (commandName === 'join') {
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: '❌ 先にボイスチャンネルに参加してください。', ephemeral: true });
        }

        await interaction.deferReply();

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false, // ユーザーの声を聞くため無効化
            selfMute: false
        });

        connection.subscribe(player);
        await interaction.editReply('🎙️ Gemini AIが参加しました！マイクに向かって話しかけてみてください。');

        setupSpeechRecognition(connection);
    }

    if (commandName === 'leave') {
        const connection = getVoiceConnection(guild.id);
        if (connection) {
            connection.destroy();
            await interaction.reply('👋 退室しました。');
        } else {
            await interaction.reply({ content: '接続されていません。', ephemeral: true });
        }
    }
});

// --- 5. 音声自動検知（ログ強化版） ---
function setupSpeechRecognition(connection) {
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId) => {
        console.log(`🎤 発話を検知しました (User: ${userId})`);

        if (player.state.status === AudioPlayerStatus.Playing) {
            console.log('⏩ AI再生中のためスキップします');
            return;
        }

        const opusStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 1000 // 1秒の無音で発話終了判定
            }
        });

        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
        const wavStream = fs.createWriteStream(TEMP_USER_AUDIO);

        opusStream.pipe(decoder).pipe(wavStream);

        wavStream.on('finish', async () => {
            console.log('🎙️ 音声録音完了。Geminiへ送信中...');
            await processGeminiAIResponse();
        });
    });
}

// --- 6. Gemini 思考 ➔ 音声再生 ---
async function processGeminiAIResponse() {
    try {
        if (!fs.existsSync(TEMP_USER_AUDIO)) {
            console.log('⚠️ 音声ファイルが存在しません');
            return;
        }

        const stats = fs.statSync(TEMP_USER_AUDIO);
        console.log(`📁 録音ファイルサイズ: ${stats.size} bytes`);

        if (stats.size < 3000) {
            console.log('⚠️ 音声データが小さすぎるため（短すぎる/雑音）処理をスキップします');
            return;
        }

        const audioBuffer = fs.readFileSync(TEMP_USER_AUDIO);
        const base64Audio = audioBuffer.toString('base64');

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const response = await model.generateContent([
            {
                inlineData: {
                    mimeType: 'audio/wav',
                    data: base64Audio
                }
            },
            'あなたはDiscordのボイスチャットで話すフレンドリーなAIです。相手の音声を聞き取り、日本語で短く簡潔に（1〜2文程度で）自然に返答してください。'
        ]);

        const aiText = response.response.text().trim();
        if (!aiText) {
            console.log('⚠️ Geminiからの返答テキストが空でした');
            return;
        }

        console.log(`🤖 Geminiの回答: "${aiText}"`);

        const ttsUrl = googleTTS.getAudioUrl(aiText, {
            lang: 'ja',
            slow: false,
            host: 'https://translate.google.com',
            timeout: 10000,
        });

        const resource = createAudioResource(ttsUrl);
        player.play(resource);

    } catch (error) {
        console.error('❌ Gemini AI処理エラー:', error);
    }
}

client.login(process.env.DISCORD_TOKEN);