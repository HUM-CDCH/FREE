torch runtimes backing the Docling pipeline. We will deliver updates on this topic at in a future version of this report.



<div style="text-align: center;">Table 1: Runtime characteristics of Docling with the standard model pipeline and settings, on our test dataset of 225 pages, on two different systems. OCR is disabled. We show the time-to-solution (TTS), computed throughput in pages per second, and the peak memory used (resident set size) for both the Docling-native PDF backend and for the pypdfium backend, using 4 and 16 threads.</div>



<div style="text-align: center;"><html><body><table border="1"><tr><td rowspan="2">CPU</td><td rowspan="2">Thread budget</td><td colspan="3">native backend</td><td rowspan="2"></td><td colspan="3">pypdfium backend</td></tr><tr><td>TTS</td><td>Pages/s</td><td>Mem</td><td>TTS</td><td>Pages/s</td><td>Mem</td></tr><tr><td rowspan="2">Apple M3 Max (16 cores)</td><td>4</td><td>177 s</td><td>1.27</td><td></td><td>6.20 GB</td><td>103 s</td><td>2.18</td><td>2.56 GB</td></tr><tr><td>16</td><td>167 s</td><td>1.34</td><td></td><td></td><td>92 s</td><td>2.45</td><td></td></tr><tr><td>Intel(R) Xeon E5-2690 (16 cores)</td><td>4 16</td><td>375 s 244 s</td><td>0.60 0.92</td><td></td><td>6.16 GB</td><td>239 s 143 s</td><td>0.94 1.57</td><td>2.42 GB</td></tr></table></body></html></div>


## 5 Applications 

Thanks to the high-quality, richly structured document conversion achieved by Docling, its output qualifies for numerous downstream applications. For example, Docling can provide a base for detailed enterprise document search, passage retrieval or classification use-cases, or support knowledge extraction pipelines, allowing specific treatment of different structures in the document,such as tables, figures, section structure or references. For popular generative AI application patterns, such as retrieval-augmented generation (RAG), we provide quackling, an open-source package which capitalizes on Docling's feature-rich document output to enable document-native optimized vector embedding and chunking. It plugs in seamlessly with LLM frameworks such as LlamaIndex [8]. Since Docling is fast, stable and cheap to run, it also makes for an excellent choice to build document-derived datasets. With its powerful table structure recognition, it provides significant benefit to automated knowledge-base construction [11, 10]. Docling is also integrated within the open IBM data prep kit [6], which implements scalable data transforms to build large-scale multi-modal training datasets.



## 6 Future work and contributions 

Docling is designed to allow easy extension of the model library and pipelines. In the future, we plan to extend Docling with several more models, such as a figure-classifier model, an equationrecognition model, a code-recognition model and more. This will help improve the quality of conversion for specific types of content, as well as augment extracted document metadata with additional information. Further investment into testing and optimizing GPU acceleration as well as improving the Docling-native PDF backend are on our roadmap, too.



We encourage everyone to propose or implement additional features and models, and will gladly take your inputs and contributions under review. The codebase of Docling is open for use and contribution, under the MIT license agreement and in alignment with our contributing guidelines included in the Docling repository. If you use Docling in your projects, please consider citing this technical report.



## References 

[1] J. AI. Easyocr: Ready-to-use ocr with 80+ supported languages. https://github.com/JaidedAI/EasyOCR, 2024. Version: 1.7.0.
[2] J. Ansel, E. Yang, H. He, N. Gimelshein, A. Jain, M. Voznesensky, B. Bao, P. Bell, D. Berard,
E. Burovski, G. Chauhan, A. Chourdia,W. Constable, A. Desmaison, Z. DeVito, E. Ellison,
W. Feng, J. Gong,M.Gschwind,B.Hirsh,S. Huang,K. Kalambarkar,L. Kirsch,M.Lazos, M. Lezcano, Y. Liang, J. Liang, Y. Lu, C. Luk, B. Maher, Y. Pan, C. Puhrsch, M. Reso,M. Saroufim, M. Y. Siraichi, H. Suk, M. Suo, P. Tillet, E. Wang, X. Wang, W. Wen, S. Zhang,
X. Zhao, K. Zhou, R. Zou, A. Mathews, G. Chanan, P. Wu, and S. Chintala. Pytorch 2: Faster 