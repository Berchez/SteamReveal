"use client"
import axios from "axios";
import Image from "next/image";


export default function Home() {

  const handleGetInfoClick = async () => {
    try {
      await axios.get('/api/test'

      );
    } catch (e) {
      console.error(e);
    } 
  };

  return (
    <div className="h-screen w-screen bg-slate-50"><button className="w-4 h-2 bg-zinc-700 text-slate-50" onClick={handleGetInfoClick}>Get Info</button></div>
    
  );
}
