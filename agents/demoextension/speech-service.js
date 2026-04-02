// Speech-to-text service supporting both Web Speech API and OpenAI Whisper API

class SpeechService {
  constructor() {
    // Mode: 'web' for Web Speech API, 'whisper' for OpenAI Whisper
    this.mode = 'web';
    this.apiKey = null;
    
    // State
    this.isActive = false;
    this.isProcessing = false;
    
    // Web Speech API
    this.recognition = null;
    this.shouldRestart = false;
    
    // Whisper API (audio recording)
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.audioStream = null;
    
    // Callbacks
    this.onResult = null;
    this.onError = null;
    this.onEnd = null;
    this.onStart = null;
    this.onProcessing = null; // Called when Whisper is processing
    
    this._initWebSpeech();
  }

  /**
   * Check if Web Speech API is supported
   */
  static isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /**
   * Check if audio recording is supported (for Whisper)
   */
  static isAudioSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /**
   * Configure the service to use Whisper API
   * @param {string} apiKey - OpenAI API key
   */
  setWhisperMode(apiKey) {
    if (apiKey && SpeechService.isAudioSupported()) {
      this.mode = 'whisper';
      this.apiKey = apiKey;
      console.log('[SpeechService] Whisper mode enabled');
    } else {
      this.mode = 'web';
      this.apiKey = null;
      console.log('[SpeechService] Using Web Speech API (Whisper not available)');
    }
  }

  /**
   * Get current mode
   */
  getMode() {
    return this.mode;
  }

  /**
   * Initialize Web Speech API
   */
  _initWebSpeech() {
    if (!SpeechService.isSupported()) {
      console.warn('[SpeechService] Web Speech API not supported');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';
    
    this.recognition.onstart = () => {
      this.isActive = true;
      console.log('[SpeechService] Web Speech started');
      if (this.onStart) this.onStart();
    };

    this.recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (this.onResult) {
        this.onResult({
          final: finalTranscript,
          interim: interimTranscript,
          isFinal: finalTranscript.length > 0
        });
      }
    };

    this.recognition.onerror = (event) => {
      console.error('[SpeechService] Web Speech error:', event.error);
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        if (this.onError) this.onError(event.error);
      }
    };

    this.recognition.onend = () => {
      this.isActive = false;
      if (this.shouldRestart) {
        try {
          this.recognition.start();
        } catch (e) {
          this.shouldRestart = false;
          if (this.onEnd) this.onEnd();
        }
      } else {
        if (this.onEnd) this.onEnd();
      }
    };
  }

  /**
   * Start listening/recording
   */
  async startListening() {
    if (this.isActive || this.isProcessing) {
      console.log('[SpeechService] Already active');
      return true;
    }

    if (this.mode === 'whisper') {
      return await this._startWhisperRecording();
    } else {
      return this._startWebSpeech();
    }
  }

  /**
   * Stop listening/recording
   */
  stopListening() {
    if (this.mode === 'whisper') {
      this._stopWhisperRecording();
    } else {
      this._stopWebSpeech();
    }
  }

  /**
   * Start Web Speech API
   */
  _startWebSpeech() {
    if (!this.recognition) {
      if (this.onError) this.onError('not-supported');
      return false;
    }

    try {
      this.shouldRestart = true;
      this.recognition.start();
      return true;
    } catch (error) {
      console.error('[SpeechService] Web Speech start failed:', error);
      this.shouldRestart = false;
      if (this.onError) this.onError('start-failed');
      return false;
    }
  }

  /**
   * Stop Web Speech API
   */
  _stopWebSpeech() {
    this.shouldRestart = false;
    if (this.recognition && this.isActive) {
      try {
        this.recognition.stop();
      } catch (error) {
        console.error('[SpeechService] Web Speech stop failed:', error);
      }
    }
    this.isActive = false;
  }

  /**
   * Start Whisper audio recording
   */
  async _startWhisperRecording() {
    try {
      // Request microphone access
      this.audioStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 16000
        } 
      });
      
      this.audioChunks = [];
      
      // Create MediaRecorder with appropriate format
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : 'audio/webm';
      
      this.mediaRecorder = new MediaRecorder(this.audioStream, { mimeType });
      
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        console.log('[SpeechService] Recording stopped, processing...');
        await this._processWhisperAudio();
      };

      this.mediaRecorder.onerror = (event) => {
        console.error('[SpeechService] MediaRecorder error:', event.error);
        if (this.onError) this.onError('recording-failed');
        this._cleanupAudioStream();
      };

      // Start recording
      this.mediaRecorder.start(1000); // Collect data every second
      this.isActive = true;
      
      console.log('[SpeechService] Whisper recording started');
      if (this.onStart) this.onStart();
      
      return true;
    } catch (error) {
      console.error('[SpeechService] Failed to start recording:', error);
      if (error.name === 'NotAllowedError') {
        if (this.onError) this.onError('microphone-denied');
      } else {
        if (this.onError) this.onError('recording-failed');
      }
      return false;
    }
  }

  /**
   * Stop Whisper audio recording
   */
  _stopWhisperRecording() {
    if (this.mediaRecorder && this.isActive) {
      this.isActive = false;
      this.mediaRecorder.stop();
      // Stream cleanup happens after processing
    }
  }

  /**
   * Process recorded audio through Whisper API
   */
  async _processWhisperAudio() {
    if (this.audioChunks.length === 0) {
      console.log('[SpeechService] No audio recorded');
      this._cleanupAudioStream();
      if (this.onEnd) this.onEnd();
      return;
    }

    this.isProcessing = true;
    if (this.onProcessing) this.onProcessing(true);

    try {
      // Create audio blob
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      console.log('[SpeechService] Audio blob size:', audioBlob.size);

      // Skip if too small (likely no speech)
      if (audioBlob.size < 1000) {
        console.log('[SpeechService] Audio too short, skipping');
        return;
      }

      // Send to Whisper API
      const formData = new FormData();
      formData.append('file', audioBlob, 'recording.webm');
      formData.append('model', 'whisper-1');
      formData.append('language', 'en');

      console.log('[SpeechService] Sending to Whisper API...');
      
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API error: ${response.status}`);
      }

      const data = await response.json();
      const transcript = data.text?.trim();

      console.log('[SpeechService] Whisper result:', transcript);

      if (transcript && this.onResult) {
        this.onResult({
          final: transcript,
          interim: '',
          isFinal: true
        });
      }
    } catch (error) {
      console.error('[SpeechService] Whisper API error:', error);
      if (this.onError) this.onError(error.message || 'transcription-failed');
    } finally {
      this.isProcessing = false;
      if (this.onProcessing) this.onProcessing(false);
      this._cleanupAudioStream();
      if (this.onEnd) this.onEnd();
    }
  }

  /**
   * Clean up audio stream
   */
  _cleanupAudioStream() {
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }
    this.audioChunks = [];
    this.mediaRecorder = null;
  }

  /**
   * Check if currently listening/recording
   */
  isListening() {
    return this.isActive;
  }

  /**
   * Check if currently processing (Whisper only)
   */
  isTranscribing() {
    return this.isProcessing;
  }

  /**
   * Set the language for recognition
   */
  setLanguage(lang) {
    if (this.recognition) {
      this.recognition.lang = lang;
    }
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SpeechService;
}
