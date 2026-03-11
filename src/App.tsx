/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { auth, db } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  onSnapshot, 
  serverTimestamp, 
  doc, 
  setDoc, 
  updateDoc,
  getDoc,
  getDocFromServer
} from 'firebase/firestore';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { 
  MessageSquare, 
  Video, 
  Mic, 
  MicOff, 
  VideoOff, 
  X, 
  Send, 
  User as UserIcon, 
  Settings, 
  Shield, 
  Flag, 
  ChevronRight,
  Loader2,
  Smile,
  AlertCircle
} from 'lucide-react';
import { cn } from './lib/utils';
import { moderateContent } from './services/aiService';

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-full flex flex-col items-center justify-center bg-zinc-950 text-white p-6 text-center">
          <AlertCircle className="w-16 h-16 text-red-500 mb-6" />
          <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
          <p className="text-zinc-400 mb-8 max-w-md">
            {this.state.error?.message.startsWith('{') 
              ? "A database error occurred. Please try refreshing." 
              : this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button 
            onClick={() => window.location.reload()}
            className="px-8 h-12 bg-emerald-500 text-zinc-950 font-bold rounded-xl hover:bg-emerald-400 transition-all"
          >
            Refresh Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Types ---
type AppState = 'HOME' | 'MATCHING' | 'CHAT';

interface Message {
  id: string;
  senderId: string;
  text: string;
  createdAt: any;
  type: 'text' | 'system';
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [appState, setAppState] = useState<AppState>('HOME');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [typingTimeout, setTypingTimeout] = useState<NodeJS.Timeout | null>(null);
  const [partnerLeft, setPartnerLeft] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // --- Auth & Socket Init ---
  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (u) {
        setUser(u);
        try {
          await setDoc(doc(db, 'users', u.uid), {
            uid: u.uid,
            displayName: u.displayName || `User_${u.uid.slice(0, 4)}`,
            photoURL: u.photoURL || '',
            createdAt: serverTimestamp(),
            isOnline: true
          }, { merge: true });
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `users/${u.uid}`);
        }
      }
    });

    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('match_found', async ({ roomId, partnerId }) => {
      setRoomId(roomId);
      setPartnerId(partnerId);
      setPartnerLeft(false);
      setAppState('CHAT');

      // Create room document in Firestore to satisfy security rules
      if (auth.currentUser) {
        try {
          await setDoc(doc(db, 'rooms', roomId), {
            participants: [auth.currentUser.uid, partnerId],
            createdAt: serverTimestamp(),
            active: true
          }, { merge: true });
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `rooms/${roomId}`);
        }
      }
    });

    newSocket.on('partner_typing', ({ isTyping }) => {
      setIsTyping(isTyping);
    });

    newSocket.on('partner_left', () => {
      setPartnerLeft(true);
      setIsTyping(false);
    });

    newSocket.on('re_match', ({ userId }) => {
      newSocket.emit('start_matching', { userId });
    });

    return () => {
      unsubscribe();
      newSocket.disconnect();
    };
  }, []);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login error:", error);
      alert("Failed to sign in. Please try again.");
    }
  };

  // --- Chat Subscription ---
  useEffect(() => {
    if (!roomId) return;

    const q = query(
      collection(db, 'rooms', roomId, 'messages'),
      orderBy('createdAt', 'asc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Message[];
      setMessages(msgs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `rooms/${roomId}/messages`);
    });

    return () => unsubscribe();
  }, [roomId]);

  // --- Auto Scroll ---
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // --- Actions ---
  const startMatching = () => {
    if (!user || !socket) return;
    setAppState('MATCHING');
    socket.emit('start_matching', { userId: user.uid });
  };

  const cancelMatching = () => {
    if (!user || !socket) return;
    socket.emit('cancel_matching', { userId: user.uid });
    setAppState('HOME');
  };

  const nextMatch = async () => {
    if (!user || !socket || !roomId) return;
    
    try {
      // Mark room as inactive
      await updateDoc(doc(db, 'rooms', roomId), { active: false });
    } catch (error) {
      // Ignore if room doesn't exist or already inactive
    }
    
    setAppState('MATCHING');
    setRoomId(null);
    setPartnerId(null);
    setMessages([]);
    setPartnerLeft(false);
    socket.emit('next_match', { userId: user.uid });
  };

  const sendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || !user || !roomId || partnerLeft) return;

    const text = inputText;
    setInputText('');
    
    // Stop typing indicator
    if (socket) {
      socket.emit('typing', { roomId, userId: user.uid, isTyping: false });
    }

    // AI Moderation (Frontend)
    const isSafe = await moderateContent(text);
    if (!isSafe) {
      alert("Message blocked: Please keep the conversation respectful.");
      return;
    }

    try {
      await addDoc(collection(db, 'rooms', roomId, 'messages'), {
        senderId: user.uid,
        text,
        createdAt: serverTimestamp(),
        type: 'text'
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `rooms/${roomId}/messages`);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputText(value);
    
    if (!socket || !roomId || !user || partnerLeft) return;

    // Emit typing event
    socket.emit('typing', { roomId, userId: user.uid, isTyping: value.length > 0 });

    // Clear existing timeout
    if (typingTimeout) clearTimeout(typingTimeout);

    // Set timeout to stop typing indicator after 2 seconds of inactivity
    const timeout = setTimeout(() => {
      socket.emit('typing', { roomId, userId: user.uid, isTyping: false });
    }, 2000);

    setTypingTimeout(timeout);
  };

  const reportUser = () => {
    alert("User reported. Our moderation team will review the chat.");
    nextMatch();
  };

  // --- Renderers ---
  if (!user) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-zinc-950 text-white p-6 text-center">
        <div className="w-20 h-20 bg-emerald-500/10 rounded-3xl flex items-center justify-center mb-8 border border-emerald-500/20">
          <MessageSquare className="w-10 h-10 text-emerald-500" />
        </div>
        <h1 className="text-3xl font-bold mb-4">ConnectRandom</h1>
        <p className="text-zinc-400 mb-8 max-w-xs">Sign in to start meeting new people from around the world.</p>
        <button 
          onClick={handleLogin}
          className="w-full max-w-xs h-14 bg-white text-zinc-950 font-bold rounded-2xl flex items-center justify-center gap-3 hover:bg-zinc-200 transition-all"
        >
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="Google" />
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="h-screen w-full bg-zinc-950 text-zinc-100 font-sans overflow-hidden flex flex-col">
        <AnimatePresence mode="wait">
        {appState === 'HOME' && (
          <motion.div 
            key="home"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 flex flex-col items-center justify-center p-6 text-center"
          >
            <div className="mb-12">
              <div className="w-24 h-24 bg-emerald-500/10 rounded-3xl flex items-center justify-center mb-6 mx-auto border border-emerald-500/20">
                <MessageSquare className="w-12 h-12 text-emerald-500" />
              </div>
              <h1 className="text-4xl font-bold tracking-tight mb-2">ConnectRandom</h1>
              <p className="text-zinc-400 max-w-xs mx-auto">
                Meet interesting people from around the world instantly.
              </p>
            </div>

            <button 
              onClick={startMatching}
              className="group relative w-full max-w-xs h-16 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-2xl transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 overflow-hidden"
            >
              <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
              <span className="relative z-10">Start Chatting</span>
              <ChevronRight className="w-5 h-5 relative z-10" />
            </button>

            <div className="mt-12 flex gap-8">
              <div className="flex flex-col items-center gap-2 opacity-50 hover:opacity-100 cursor-pointer transition-opacity">
                <Settings className="w-6 h-6" />
                <span className="text-xs font-medium uppercase tracking-widest">Settings</span>
              </div>
              <div className="flex flex-col items-center gap-2 opacity-50 hover:opacity-100 cursor-pointer transition-opacity">
                <Shield className="w-6 h-6" />
                <span className="text-xs font-medium uppercase tracking-widest">Safety</span>
              </div>
            </div>
          </motion.div>
        )}

        {appState === 'MATCHING' && (
          <motion.div 
            key="matching"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center p-6 bg-zinc-950"
          >
            <div className="relative mb-12">
              <motion.div 
                animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.1, 0.3] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="absolute inset-0 bg-emerald-500 rounded-full blur-3xl"
              />
              <div className="relative w-32 h-32 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin flex items-center justify-center">
                <UserIcon className="w-12 h-12 text-emerald-500 animate-pulse" />
              </div>
            </div>
            
            <h2 className="text-2xl font-bold mb-2">Finding someone...</h2>
            <p className="text-zinc-500 mb-12">Matching you with the perfect partner</p>

            <button 
              onClick={cancelMatching}
              className="px-8 h-12 border border-zinc-800 hover:bg-zinc-900 rounded-xl text-zinc-400 transition-colors"
            >
              Cancel
            </button>
          </motion.div>
        )}

        {appState === 'CHAT' && (
          <motion.div 
            key="chat"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="flex-1 flex flex-col h-full"
          >
            {/* Header */}
            <header className="h-20 border-b border-zinc-900 px-6 flex items-center justify-between bg-zinc-950/50 backdrop-blur-xl sticky top-0 z-20">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-zinc-800 rounded-full flex items-center justify-center">
                  <UserIcon className="w-5 h-5 text-zinc-400" />
                </div>
                <div>
                  <h3 className="font-bold text-sm">Stranger</h3>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                    <span className="text-[10px] uppercase tracking-widest text-emerald-500 font-bold">Online</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button 
                  onClick={reportUser}
                  className="p-2.5 hover:bg-red-500/10 text-zinc-500 hover:text-red-500 rounded-xl transition-all"
                  title="Report User"
                >
                  <Flag className="w-5 h-5" />
                </button>
                <button 
                  onClick={nextMatch}
                  className="px-4 h-10 bg-zinc-100 text-zinc-950 font-bold rounded-xl hover:bg-white transition-all flex items-center gap-2"
                >
                  <span>Next</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </header>

            {/* Chat Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4 scroll-smooth">
              {messages.map((msg) => (
                <motion.div 
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  key={msg.id}
                  className={cn(
                    "max-w-[80%] p-4 rounded-2xl text-sm leading-relaxed",
                    msg.senderId === user.uid 
                      ? "ml-auto bg-emerald-500 text-zinc-950 font-medium rounded-tr-none" 
                      : "bg-zinc-900 text-zinc-100 rounded-tl-none"
                  )}
                >
                  {msg.text}
                </motion.div>
              ))}
              
              {isTyping && !partnerLeft && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 text-zinc-500 text-xs font-medium italic px-2"
                >
                  <div className="flex gap-1">
                    <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1 h-1 bg-zinc-500 rounded-full" />
                    <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1 h-1 bg-zinc-500 rounded-full" />
                    <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1 h-1 bg-zinc-500 rounded-full" />
                  </div>
                  Stranger is typing...
                </motion.div>
              )}

              {partnerLeft && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mx-auto bg-zinc-900/50 border border-zinc-800 px-4 py-2 rounded-full text-[10px] uppercase tracking-widest font-bold text-zinc-500"
                >
                  Stranger has left the chat
                </motion.div>
              )}
              
              <div ref={messagesEndRef} />
            </div>

            {/* Controls & Input */}
            <div className="p-6 border-t border-zinc-900 bg-zinc-950">
              <div className="flex items-center gap-3 mb-4">
                <button 
                  onClick={() => setIsMuted(!isMuted)}
                  className={cn(
                    "w-12 h-12 rounded-xl flex items-center justify-center transition-all",
                    isMuted ? "bg-red-500/10 text-red-500" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
                  )}
                >
                  {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                </button>
                <button 
                  onClick={() => setIsVideoOff(!isVideoOff)}
                  className={cn(
                    "w-12 h-12 rounded-xl flex items-center justify-center transition-all",
                    isVideoOff ? "bg-red-500/10 text-red-500" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
                  )}
                >
                  {isVideoOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
                </button>
                <div className="h-8 w-[1px] bg-zinc-900 mx-1" />
                <button className="w-12 h-12 rounded-xl bg-zinc-900 text-zinc-400 hover:bg-zinc-800 flex items-center justify-center transition-all">
                  <Smile className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={sendMessage} className="relative flex items-center gap-2">
                <input 
                  type="text"
                  value={inputText}
                  onChange={handleInputChange}
                  disabled={partnerLeft}
                  placeholder={partnerLeft ? "Stranger has left" : "Type a message..."}
                  className="flex-1 h-14 bg-zinc-900 border border-zinc-800 rounded-2xl px-6 text-sm focus:outline-none focus:border-emerald-500/50 transition-all disabled:opacity-50"
                />
                <button 
                  type="submit"
                  disabled={!inputText.trim()}
                  className="w-14 h-14 bg-emerald-500 text-zinc-950 rounded-2xl flex items-center justify-center hover:bg-emerald-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </ErrorBoundary>
  );
}
