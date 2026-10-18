import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from 'discord.js';
import { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus, 
    EndBehaviorType, 
    getVoiceConnection 
} from '@discordjs/voice';
import { GoogleGenAI } from '@google/genai';
import * as googleTTS from 'google-tts-api';
import prism from 'prism-media';
import fs from 'fs';
import path from 'path';
import http from 'http';
import 'dotenv/config';

// --- 1. Renderスリープ防止Webサーバー ---
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

// Gemini SDKの初期化（環境変数 GEMINI_API_KEY を自動参照）
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const player = createAudioPlayer();

const TEMP_USER_AUDIO = path.resolve('./temp_user.wav');

// --- 3. コマンド定義 ---
const commands = [
    new SlashCommandBuilder().setName('join').setDescription('VCに参加してGemini AIと会話を開始します'),
    new SlashCommandBuilder().setName('leave').setDescription('VCから退室します')
];

client.once('ready', async () => {
    console.log(`✅ ログイン完了: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ スラッシュコマンド登録完了');
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
            selfDeaf: false,
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

// --- 5. 音声自動検知（ハンズフリー会話） ---
function setupSpeechRecognition(connection) {
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId) => {
        if (player.state.status === AudioPlayerStatus.Playing) return;

        // 0.8秒間無音が続いたら発話終了と判定
        const opusStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 800
            }
        });

        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
        const wavStream = fs.createWriteStream(TEMP_USER_AUDIO);

        opusStream.pipe(decoder).pipe(wavStream);

        wavStream.on('finish', async () => {
            await processGeminiAIResponse();
        });
    });
}

// --- 6. Gemini API 音声理解 ➔ テキスト生成 ➔ 音声読み上げ ---
async function processGeminiAIResponse() {
    try {
        if (!fs.existsSync(TEMP_USER_AUDIO) || fs.statSync(TEMP_USER_AUDIO).size < 2000) return;

        // 録音した音声ファイルを Base64 に変換
        const audioBuffer = fs.readFileSync(TEMP_USER_AUDIO);
        const base64Audio = audioBuffer.toString('base64');

        // Gemini 2.5 Flash に直接音声を渡して回答を得る
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    inlineData: {
                        mimeType: 'audio/wav',
                        data: base64Audio
                    }
                },
                {
                    text: 'あなたはDiscordのボイスチャットで話すフレンドリーなAIです。相手の音声を聞き取り、日本語で短く簡潔に（1〜2文程度で）自然に返答してください。'
                }
            ]
        });

        const aiText = response.text ? response.text.trim() : '';
        if (!aiText) return;

        console.log(`🤖 Gemini: "${aiText}"`);

        // Google TTS でテキストを音声URL（MP3）に変換
        const ttsUrl = googleTTS.getAudioUrl(aiText, {
            lang: 'ja',
            slow: false,
            host: 'https://translate.google.com',
            timeout: 10000,
        });

        // ボイスチャンネルで再生
        const resource = createAudioResource(ttsUrl);
        player.play(resource);

    } catch (error) {
        console.error('❌ Gemini AI処理エラー:', error);
    }
}

client.login(process.env.DISCORD_TOKEN);