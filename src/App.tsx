import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Sparkles, Trash2, Github, Command, ExternalLink, Globe, LogIn, LogOut, X, Image as ImageIcon, Loader2, Waves, Hexagon, ListTodo, Plus, CheckCircle2, Circle, Check, Settings2, Maximize2 } from 'lucide-react';
import Markdown from 'react-markdown';
import { motion, AnimatePresence } from 'motion/react';
import { sendMessageStream, generateImage } from './services/geminiService';
import { cn } from './lib/utils';
import { auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged, User as FirebaseUser, db } from './lib/firebase';
import { collection, addDoc, getDocs, query, orderBy, deleteDoc, doc, writeBatch, serverTimestamp, updateDoc, onSnapshot } from 'firebase/firestore';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  sources?: { uri: string; title: string }[];
  imageUrl?: string;
  isImage?: boolean;
}

interface Task {
  id: string;
  text: string;
  completed: boolean;
  timestamp: number;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [input, setInput] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [showLoginBar, setShowLoginBar] = useState(true);
  const [showTasks, setShowTasks] = useState(false);
  const [imageSettings, setImageSettings] = useState<{ aspectRatio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9", style: string }>({
    aspectRatio: "1:1",
    style: "Photorealistic"
  });
  const [showImageSettings, setShowImageSettings] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let unsubscribeMessages: () => void = () => {};
    let unsubscribeTasks: () => void = () => {};

    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        setShowLoginBar(false);
        
        // Listen to messages
        const messagesRef = collection(db, 'users', currentUser.uid, 'messages');
        const messagesQuery = query(messagesRef, orderBy('timestamp', 'asc'));
        unsubscribeMessages = onSnapshot(messagesQuery, (snapshot) => {
          const loadedMessages: Message[] = [];
          snapshot.forEach((doc) => {
            loadedMessages.push({ id: doc.id, ...doc.data() } as Message);
          });
          setMessages(loadedMessages);
        });

        // Listen to tasks
        const tasksRef = collection(db, 'users', currentUser.uid, 'tasks');
        const tasksQuery = query(tasksRef, orderBy('timestamp', 'desc'));
        unsubscribeTasks = onSnapshot(tasksQuery, (snapshot) => {
          const loadedTasks: Task[] = [];
          snapshot.forEach((doc) => {
            loadedTasks.push({ id: doc.id, ...doc.data() } as Task);
          });
          setTasks(loadedTasks);
        });
      } else {
        setMessages([]);
        setTasks([]);
        unsubscribeMessages();
        unsubscribeTasks();
      }
    });

    return () => {
      unsubscribeAuth();
      unsubscribeMessages();
      unsubscribeTasks();
    };
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const isImageRequest = input.toLowerCase().startsWith('/image ') || input.toLowerCase().startsWith('generate image ');
    const prompt = isImageRequest ? input.replace(/^\/image |^generate image /i, '') : input.trim();

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    // Save user message to Firestore if logged in
    if (user) {
      try {
        await addDoc(collection(db, 'users', user.uid, 'messages'), {
          role: userMessage.role,
          content: userMessage.content,
          timestamp: userMessage.timestamp,
        });
      } catch (error) {
        console.error("Error saving user message:", error);
      }
    }

    const assistantMessageId = (Date.now() + 1).toString();
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isImage: isImageRequest,
    };

    setMessages((prev) => [...prev, assistantMessage]);

    if (isImageRequest) {
      try {
        const imageUrl = await generateImage(prompt, { 
          aspectRatio: imageSettings.aspectRatio, 
          style: imageSettings.style 
        });
        const updatedAssistantMessage = { ...assistantMessage, imageUrl, content: `Generated ${imageSettings.aspectRatio} ${imageSettings.style} image for: "${prompt}"` };
        
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId 
              ? updatedAssistantMessage
              : msg
          )
        );

        // Save assistant image message to Firestore if logged in
        if (user) {
          await addDoc(collection(db, 'users', user.uid, 'messages'), {
            role: updatedAssistantMessage.role,
            content: updatedAssistantMessage.content,
            timestamp: updatedAssistantMessage.timestamp,
            imageUrl: updatedAssistantMessage.imageUrl,
            isImage: true
          });
        }
      } catch (error) {
        console.error('Image generation failed:', error);
        const errorContent = 'Sorry, I failed to generate the image. Please try again.';
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, content: errorContent }
              : msg
          )
        );
        if (user) {
          await addDoc(collection(db, 'users', user.uid, 'messages'), {
            role: 'assistant',
            content: errorContent,
            timestamp: Date.now(),
          });
        }
      } finally {
        setIsLoading(false);
      }
      return;
    }

    try {
      let fullContent = '';
      let sources: { uri: string; title: string }[] = [];
      const stream = sendMessageStream(userMessage.content);
      
      for await (const chunk of stream) {
        fullContent += chunk.text || '';
        
        // Extract sources from grounding metadata if available
        if (chunk.groundingMetadata?.groundingChunks) {
          const newSources = chunk.groundingMetadata.groundingChunks
            .filter((c: any) => c.web)
            .map((c: any) => ({
              uri: c.web.uri,
              title: c.web.title,
            }));
          
          // Only add unique sources
          newSources.forEach((s: any) => {
            if (!sources.find(existing => existing.uri === s.uri)) {
              sources.push(s);
            }
          });
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId 
              ? { ...msg, content: fullContent, sources: sources.length > 0 ? sources : undefined } 
              : msg
          )
        );
      }

      // Save assistant message to Firestore after stream complete
      if (user) {
        await addDoc(collection(db, 'users', user.uid, 'messages'), {
          role: 'assistant',
          content: fullContent,
          timestamp: Date.now(),
          sources: sources.length > 0 ? sources : null
        });
      }
    } catch (error) {
      console.error('Failed to get response:', error);
      const errorContent = 'Sorry, I encountered an error. Please try again.';
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? { ...msg, content: errorContent }
            : msg
        )
      );
      if (user) {
        await addDoc(collection(db, 'users', user.uid, 'messages'), {
          role: 'assistant',
          content: errorContent,
          timestamp: Date.now(),
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const clearChat = async () => {
    setMessages([]);
    if (user) {
      try {
        const messagesRef = collection(db, 'users', user.uid, 'messages');
        const querySnapshot = await getDocs(messagesRef);
        const batch = writeBatch(db);
        querySnapshot.forEach((doc) => {
          batch.delete(doc.ref);
        });
        await batch.commit();
      } catch (error) {
        console.error("Error clearing chat history:", error);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const addTask = async () => {
    if (!taskInput.trim() || !user) return;
    try {
      await addDoc(collection(db, 'users', user.uid, 'tasks'), {
        text: taskInput.trim(),
        completed: false,
        timestamp: Date.now(),
      });
      setTaskInput('');
    } catch (error) {
      console.error("Error adding task:", error);
    }
  };

  const toggleTask = async (task: Task) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'users', user.uid, 'tasks', task.id), {
        completed: !task.completed,
      });
    } catch (error) {
      console.error("Error toggling task:", error);
    }
  };

  const deleteTask = async (taskId: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'tasks', taskId));
    } catch (error) {
      console.error("Error deleting task:", error);
    }
  };

  return (
    <div className="flex h-screen bg-[#050505] text-[#e5e5e5] selection:bg-white/20 overflow-hidden">
      {/* Task Sidebar */}
      <AnimatePresence>
        {showTasks && (
          <motion.aside
            initial={{ x: -320 }}
            animate={{ x: 0 }}
            exit={{ x: -320 }}
            className="w-80 border-r border-white/10 bg-[#0a0a0a] flex flex-col z-20"
          >
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ListTodo className="w-5 h-5 text-indigo-400" />
                <h2 className="font-bold tracking-tight">Tasks</h2>
              </div>
              <button onClick={() => setShowTasks(false)} className="p-1 hover:bg-white/5 rounded-lg transition-colors">
                <X className="w-4 h-4 text-white/40" />
              </button>
            </div>

            <div className="p-4">
              <div className="relative flex items-center gap-2 bg-white/5 rounded-xl p-2 focus-within:bg-white/10 transition-all border border-white/10">
                <input
                  type="text"
                  value={taskInput}
                  onChange={(e) => setTaskInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTask()}
                  placeholder="New task..."
                  className="flex-1 bg-transparent border-none focus:ring-0 text-sm py-1 px-2"
                />
                <button
                  onClick={addTask}
                  className="p-1.5 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
              {tasks.map((task) => (
                <motion.div
                  key={task.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="group flex items-center gap-3 p-3 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-all"
                >
                  <button
                    onClick={() => toggleTask(task)}
                    className="relative flex items-center justify-center"
                  >
                    <AnimatePresence mode="wait">
                      {task.completed ? (
                        <motion.div
                          key="checked"
                          initial={{ scale: 0.5, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.5, opacity: 0 }}
                          className="text-indigo-400"
                        >
                          <CheckCircle2 className="w-5 h-5 fill-indigo-400/20" />
                        </motion.div>
                      ) : (
                        <motion.div
                          key="unchecked"
                          initial={{ scale: 0.5, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.5, opacity: 0 }}
                          className="text-white/20 group-hover:text-white/40"
                        >
                          <Circle className="w-5 h-5" />
                        </motion.div>
                      )}
                    </AnimatePresence>
                    {task.completed && (
                      <motion.div
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: [0, 1.5, 1], opacity: [0, 1, 0] }}
                        transition={{ duration: 0.4 }}
                        className="absolute inset-0 bg-indigo-400 rounded-full blur-sm"
                      />
                    )}
                  </button>
                  
                  <div className="flex-1 min-w-0 relative">
                    <span className={cn(
                      "text-sm transition-all duration-300 block truncate",
                      task.completed ? "text-white/20" : "text-white/80"
                    )}>
                      {task.text}
                    </span>
                    {task.completed && (
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: '100%' }}
                        className="absolute top-1/2 left-0 h-[1px] bg-white/20 -translate-y-1/2"
                      />
                    )}
                  </div>

                  <button
                    onClick={() => deleteTask(task.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/10 rounded-lg transition-all text-red-500/40 hover:text-red-500"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </motion.div>
              ))}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col relative">
      {/* Login Bar */}
      <AnimatePresence>
        {!user && showLoginBar && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-white text-black py-2 px-6 flex items-center justify-between overflow-hidden"
          >
            <div className="flex items-center gap-3">
              <Sparkles className="w-4 h-4" />
              <span className="text-xs font-medium tracking-tight">Sign in to save your chat history and sync across devices.</span>
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={handleLogin}
                className="text-xs font-bold uppercase tracking-widest hover:underline"
              >
                Sign In with Google
              </button>
              <button onClick={() => setShowLoginBar(false)} className="p-1 hover:bg-black/10 rounded-full transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-bottom border-white/10 bg-[#050505]/80 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-black rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(255,255,255,0.05)] border border-white/10 relative group overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
            <Hexagon className="w-6 h-6 text-indigo-400 fill-indigo-400/10 animate-[pulse_3s_infinite_ease-in-out]" />
          </div>
          <div className="flex flex-col">
            <h1 className="text-xl font-bold tracking-tight">QUTA</h1>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
              <span className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Internet Connected</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {user ? (
            <div className="flex items-center gap-3">
              <div className="flex flex-col items-end">
                <span className="text-xs font-medium text-white/80">{user.displayName}</span>
                <button onClick={handleLogout} className="text-[10px] text-white/40 hover:text-white/60 uppercase tracking-widest transition-colors">Sign Out</button>
              </div>
              {user.photoURL && (
                <img src={user.photoURL} alt="Profile" className="w-8 h-8 rounded-lg border border-white/10" referrerPolicy="no-referrer" />
              )}
            </div>
          ) : (
            <button
              onClick={handleLogin}
              className="flex items-center gap-2 px-4 py-2 bg-white text-black rounded-lg text-sm font-medium hover:scale-105 transition-all"
            >
              <LogIn className="w-4 h-4" />
              <span>Login</span>
            </button>
          )}
          <div className="h-6 w-[1px] bg-white/10" />
          <button
            onClick={() => setShowTasks(!showTasks)}
            className={cn(
              "p-2 rounded-lg transition-colors",
              showTasks ? "bg-indigo-500/20 text-indigo-400" : "hover:bg-white/10 text-white/60 hover:text-white"
            )}
            title="Tasks"
          >
            <ListTodo className="w-5 h-5" />
          </button>
          <div className="h-6 w-[1px] bg-white/10" />
          <button
            onClick={clearChat}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors text-white/60 hover:text-white"
            title="Clear Chat"
          >
            <Trash2 className="w-5 h-5" />
          </button>
          <div className="h-6 w-[1px] bg-white/10" />
          <div className="flex items-center gap-2 text-xs font-medium text-white/40 uppercase tracking-widest">
            <Command className="w-3 h-3" />
            <span>v1.0.0</span>
          </div>
        </div>
      </header>

      {/* Chat Area */}
      <main className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-3xl mx-auto px-6 py-12">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-20 text-center">
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.5 }}
                className="relative mb-10"
              >
                <div className="w-24 h-24 bg-black rounded-[2rem] flex items-center justify-center border border-white/10 shadow-[0_0_50px_rgba(255,255,255,0.02)]">
                  <Hexagon className="w-12 h-12 text-indigo-400 fill-indigo-400/5 animate-[spin_10s_linear_infinite]" />
                </div>
                <div className="absolute -inset-4 bg-indigo-500/5 blur-3xl rounded-full -z-10 animate-pulse" />
              </motion.div>
              <h2 className="text-4xl font-bold mb-4 tracking-tight bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">How can I help you today?</h2>
              <p className="text-white/40 max-w-md mx-auto leading-relaxed">
                QUTA is your intelligent companion for coding, writing, and creative exploration.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-12 w-full">
                {[
                  "Explain quantum computing in simple terms",
                  "Write a Python script for data analysis",
                  "Help me brainstorm names for a startup",
                  "/image A futuristic city in Ghibli style"
                ].map((suggestion, i) => (
                  <button
                    key={i}
                    onClick={() => setInput(suggestion)}
                    className="p-4 text-left bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-all text-sm text-white/60 hover:text-white flex items-center justify-between group"
                  >
                    <span>{suggestion}</span>
                    {suggestion.startsWith('/image') && <ImageIcon className="w-4 h-4 opacity-40 group-hover:opacity-100 transition-opacity" />}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-8">
              <AnimatePresence initial={false}>
                {messages.map((message) => (
                  <motion.div
                    key={message.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      "flex gap-6",
                      message.role === 'user' ? "flex-row-reverse" : "flex-row"
                    )}
                  >
                    <div className={cn(
                      "w-8 h-8 rounded-full flex items-center justify-center shrink-0 border",
                      message.role === 'user' 
                        ? "bg-white/10 border-white/20" 
                        : "bg-black border-white/10 shadow-[0_0_10px_rgba(255,255,255,0.05)]"
                    )}>
                      {message.role === 'user' ? (
                        <User className="w-4 h-4 text-white" />
                      ) : (
                        <Hexagon className="w-4 h-4 text-indigo-400 animate-pulse" />
                      )}
                    </div>
                    <div className={cn(
                      "flex-1 max-w-[85%]",
                      message.role === 'user' ? "text-right" : "text-left"
                    )}>
                      <div className={cn(
                        "inline-block rounded-2xl p-4 text-sm leading-relaxed",
                        message.role === 'user' 
                          ? "bg-white/10 text-white" 
                          : "bg-transparent text-white/90"
                      )}>
                        {message.role === 'assistant' ? (
                          <div className="space-y-4">
                            {message.isImage && !message.imageUrl ? (
                              <div className="flex flex-col items-center justify-center py-8 space-y-4 bg-white/5 rounded-xl border border-white/10">
                                <Loader2 className="w-8 h-8 animate-spin text-white/40" />
                                <p className="text-xs text-white/40 uppercase tracking-widest font-medium">Generating your masterpiece...</p>
                              </div>
                            ) : message.imageUrl ? (
                              <div className="space-y-3">
                                <div className="relative group overflow-hidden rounded-xl border border-white/10">
                                  <img 
                                    src={message.imageUrl} 
                                    alt="Generated" 
                                    className="w-full h-auto object-cover transition-transform duration-500 group-hover:scale-105"
                                    referrerPolicy="no-referrer"
                                  />
                                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                    <a 
                                      href={message.imageUrl} 
                                      download="generated-image.png"
                                      className="p-3 bg-white text-black rounded-full hover:scale-110 transition-transform"
                                    >
                                      <ExternalLink className="w-5 h-5" />
                                    </a>
                                  </div>
                                </div>
                                <p className="text-xs text-white/40 italic">"{message.content.replace('Generated image for: ', '').replace(/"/g, '')}"</p>
                              </div>
                            ) : (
                              <div className="markdown-body">
                                <Markdown>{message.content || '...'}</Markdown>
                              </div>
                            )}
                            {message.sources && message.sources.length > 0 && (
                              <div className="mt-4 pt-4 border-t border-white/10">
                                <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/40 mb-3 font-bold">
                                  <Globe className="w-3 h-3" />
                                  <span>Sources</span>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {message.sources.map((source, idx) => (
                                    <a
                                      key={idx}
                                      href={source.uri}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-white/60 hover:text-white transition-all group"
                                    >
                                      <span className="max-w-[150px] truncate">{source.title}</span>
                                      <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </a>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap">{message.content}</p>
                        )}
                      </div>
                      <div className="mt-2 text-[10px] uppercase tracking-widest text-white/20 font-medium">
                        {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </main>

      {/* Input Area */}
      <footer className="p-6 bg-gradient-to-t from-[#050505] via-[#050505] to-transparent">
        <div className="max-w-3xl mx-auto relative">
          <div className="flex items-center gap-2 mb-3 ml-2">
            <div className="flex items-center gap-1.5 px-2 py-1 bg-white/5 border border-white/10 rounded-full">
              <Globe className="w-3 h-3 text-blue-400" />
              <span className="text-[10px] text-white/60 uppercase tracking-widest font-bold">Search Enabled</span>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1 bg-white/5 border border-white/10 rounded-full">
              <ImageIcon className="w-3 h-3 text-purple-400" />
              <span className="text-[10px] text-white/60 uppercase tracking-widest font-bold">Image Gen Active</span>
            </div>
            
            {/* Image Settings Popover */}
            <div className="relative">
              <button 
                onClick={() => setShowImageSettings(!showImageSettings)}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-full border transition-all",
                  showImageSettings ? "bg-indigo-500/20 border-indigo-500/40 text-indigo-400" : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                )}
              >
                <Settings2 className="w-3 h-3" />
                <span className="text-[10px] uppercase tracking-widest font-bold">Settings</span>
              </button>

              <AnimatePresence>
                {showImageSettings && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute bottom-full left-0 mb-4 w-64 bg-[#0a0a0a] border border-white/10 rounded-2xl p-4 shadow-2xl z-30"
                  >
                    <div className="space-y-4">
                      <div>
                        <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold block mb-2">Aspect Ratio</label>
                        <div className="grid grid-cols-3 gap-2">
                          {(["1:1", "4:3", "3:4", "16:9", "9:16"] as const).map((ratio) => (
                            <button
                              key={ratio}
                              onClick={() => setImageSettings(prev => ({ ...prev, aspectRatio: ratio }))}
                              className={cn(
                                "px-2 py-1.5 rounded-lg text-[10px] font-bold border transition-all",
                                imageSettings.aspectRatio === ratio 
                                  ? "bg-white text-black border-white" 
                                  : "bg-white/5 border-white/10 text-white/40 hover:bg-white/10"
                              )}
                            >
                              {ratio}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold block mb-2">Style</label>
                        <div className="grid grid-cols-2 gap-2">
                          {["Photorealistic", "Digital Art", "Cyberpunk", "Ghibli", "Oil Painting", "Vector"].map((style) => (
                            <button
                              key={style}
                              onClick={() => setImageSettings(prev => ({ ...prev, style }))}
                              className={cn(
                                "px-2 py-1.5 rounded-lg text-[10px] font-bold border transition-all truncate",
                                imageSettings.style === style 
                                  ? "bg-white text-black border-white" 
                                  : "bg-white/5 border-white/10 text-white/40 hover:bg-white/10"
                              )}
                            >
                              {style}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
          <div className="rainbow-border-container group">
            <div className="rainbow-glow group-focus-within:opacity-60 transition-opacity" />
            <div className="rainbow-border-gradient" />
            <div className="relative flex items-end gap-2 bg-[#0a0a0a] rounded-[calc(1rem-1px)] p-2 focus-within:bg-[#050505] transition-all shadow-2xl z-10">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Message QUTA..."
                rows={1}
                className="flex-1 bg-transparent border-none focus:ring-0 text-sm py-3 px-4 resize-none max-h-48 custom-scrollbar"
                style={{ height: 'auto' }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = `${target.scrollHeight}px`;
                }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className={cn(
                  "p-3 rounded-xl transition-all",
                  input.trim() && !isLoading 
                    ? "bg-white text-black hover:scale-105" 
                    : "bg-white/5 text-white/20 cursor-not-allowed"
                )}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
          <p className="text-center text-[10px] text-white/20 mt-4 uppercase tracking-widest font-medium">
            QUTA can make mistakes. Check important info.
          </p>
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
      </div>
    </div>
  );
}
