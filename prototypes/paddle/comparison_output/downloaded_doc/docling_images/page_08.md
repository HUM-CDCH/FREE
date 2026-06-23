KDD '22, August 14–18, 2022, Washington, DC, USA Birgit Pfitzmann, Christoph Auer, Michele Dolfi, Ahmed S. Nassar, and Peter Staar

Table 2: Prediction performance (mAP@0.5-0.95) of object detection networks on DocLayNet test set. The MRCNN (Mask R-CNN) and FRCNN (Faster R-CNN) models with (Mask R-CNN R50, R101-FPN 3x, Faster R-CNN R101-FPN ResNet-50 or ResNet-101 backbone were trained based on the network architectures from the detectron2 model zoo -     [ ing pre-trained weights from the COCO 2017 dataset. 3x), with default configurations. The YOLO implementation

|                                                                                                        | human                                                                   | R50 MRCNN R101                                                                                                         | FRCNN R101                                                  | YOLO V5x6                                                   |
|--------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------|-------------------------------------------------------------|
| Caption Footnote Page-footer Formula List-item All Page-header Section-header Title Picture Table Text | 84-89 93-94 83-91 83-85 87-88 69.71 82-83 85-89 83-84 77-81 84-86 60-72 | 68.4 71.5 81.2 604 61.6 60.1 59.3 71.8 63.4 80.8 76.7 72.4 71.9 71.7 67.6 82.2 84.6 73.5 6963 82.9 85.8 80.4 70.0 72.7 | 70.1 73.7 63.5 81.0 58.9 72.0 82.2 85.4 79.9 72.0 68.4 73.4 | 77.7 77.2 66.2 86.2 61.1 67.9 74.6 86.3 88.1 82.7 76.8 77.1 |

to avoid this at any cost in order to have clear, unbiased baseline obtain a pixel-accurate annotation and again reduce time and effort. The CCS annotation tool automatically shrinks every user-drawn numbers for human document-layout annotation. Third, we introduced the feature of snapping boxes around text segments to box to the minimum bounding-box around the enclosed text-cells Picture. For the latter, we instructed annotation staff to minimise for all purely text-based segments, which excludes only Table and inclusion of surrounding whitespace while including all graphical lines. A downside of snapping boxes to enclosed text cells is that some wrongly parsed PDF pages cannot be annotated correctly and need to be skipped. Fourth, we established a way to flag pages as rejected for cases where no valid annotation acconding to the label guidelines could be achieved. Example cases for this would be PDF pages that render incorrectly or contain layouts that are impossible to capture with non-overlapping rectangles. Such rejected pages are not contained in the final dataset. With all these measures in place, experienced annotation staff managed to annotate a single page in a typical timeframe of 20s to 60s, depending on its complexity.

## 5 EXPERIMENTS

The primary goal of DocLayNet is to obtain high-quality ML models general frameworks such as detectron2 [17]. Furthermore, baseline object detection models such as Mask R-CNN and Faster R-CNN. As such, we will relate to these object detection methods in this of challenging layouts. As discussed in Section 2, object detection models are currently the easiest to use, due to the standardisation of ground-truth data in COCO format [16] and the availability of numbers in PubLayNet and DocBank were obtained using standard capable of accurate document-layout analysis on a wide variety paper and leave the detailed evaluation of more recent methods mentioned in Section 2 for future work.

size of the DocLayNet dataset with similar data will not yield significantly better predictions. Figure 5: Prediction performance (mAP@0.5-0.95) of a Mask R-CNN network with ResNet50 backbone trained on increasing fractions of the DocLayNet dataset. The learning curve flattens around the 80% mark, indicating that increasing the

<!-- image -->

performance of object detection models on DocLayNet. Similarly as in PubLayNet, we will evaluate the quality of their predictions In this section, we will present several aspects related to the using mean average precision (mAP) with 10 overlaps that range computed by leveraging the evaluation code provided by the COCO API [16].

## Baselines for Object Detection

In Table 2, we present baseline experiments (given in mAP) on Mask R-CNN [12], Faster R-CNN [11], and YOLOv5 [13]. Both training in mAP between the models is rather low, but overall between 6 annotations on triple-annotated pages. This gives a good indication and evaluation were performed on RGB images with dimensions of 1025× 1025 pixels. For training, we only used one annotation in case of redundantly annotated pages. As one can observe, the variation and 10% lower than the mAP computed from the pairwise human that the DocLayNet dataset poses a worthwhile challenge for the research community to close the gap between human recognition more recent Yolov5x model does very well and even out-performs Faster R-CNN produce very comparable mAP scores, indicating the most visually distinctive in a document. and ML approaches. It is interesting to see that Mask R-CNN and that pixel-based image segmentation derived from bounding-boxes does not help to obtain better predictions. On the other hand, the humans on selected labels such as Text, Table and Picture. This is not entirely surprising, as Text, Table and Picture are abundant and Table 2: Preciction pertormence (mAP@0.5-0.95) of objoct detection networks on DocLayNot test set. The MRCNN (Mask R-CNN) and FRCNN (Faster R-CNN) models with ResNet-G0 or ResNet-101 beckbone wese trained besed on the network architectures from the detectron2 model zoo (Maak R-CNN R50, R101-PPN 3a, Faster F-CNN R101-FPN 3x), with detault configurations. The YOLO implementation utlized was YOLOvtixt [13), At models wane initalised using pre-trained weights from the COCO 2017 dataset.

|                | huan   |   MRCNN |   MRCNN |   FRCNN |   VOLO |
|----------------|--------|---------|---------|---------|--------|
| Caption        | 04-09  |    03.4 |    71.5 |    70.1 |   77.7 |
| Footnote       | 8-91   |    70.9 |    71.4 |    73.7 |    772 |
| Formula        | 8-85   |     8.1 |    63.4 |    83.5 |   66.2 |
| List-term      | 87-88  |    81.2 |    80.8 |    81.0 |   86.2 |
| Page-oofter    | 93-94  |    61.6 |    50.3 |    58.9 |   61.1 |
| Page-heeder    | 858)   |    71.9 |    70.0 |    72.0 |   67.9 |
| Pieture        | 09.71  |    71.7 |    72.7 |    72.0 |   77.1 |
| Section-header | 8384   |    67.6 |    69.3 |    68.4 |   74.8 |
| Table          | 77-81  |    82.2 |    82.9 |    82.2 |   86.3 |
| Tee            | 84-09  |    84.6 |    66.8 |    85.4 |   88.1 |
| Tetle          | 00-72  |    76.7 |    60.4 |    79.9 |   82.7 |
| AI             | 02-03  |    72.4 |    72.5 |    73.4 |   76.8 |

to avoid this at any cost in ordier to have clear, unbiased baseline numbers for humen documeno-layout amnotation. Thind, we introduced the feoture of snapping bowes around text sagments to obtain a pixel-aocurate anottion and agein recuce Sime and effon. The CCS annotation tool automatically shrinks ewery uer-drawn box to the minimum bounding-box around the enclosed teet-ceils for all purely teatbased segments, which excludes onily Table and Pictune . For the lattet, we inatructed annotation atatf to minimise indusion of sumounding whitespece while including alt raphicel lines. A downside of snapping bowes to ondosed text celtsis thet some wrongly persed PDF dataset. Wim al these measures in plece, experienced annotation stf menaged to annotane a single page in a typical timeframe of 20s to 60s. depending on is compiesity. pages cannot be annotated correcty and need to be skipped. Fourth, we established a way to flag pages as rejected for ceses where no vald annotation acoonding to the label guidelnes could be achieved. Example cases for this would be POF pages that render inconactly or contain layouts that ane impcosible to capture with non-overlapping rectangles. Such rejected pages ane not contained in the final

## 5 EXPERIMENTS

challenging layouts. As discussed in Section 2. object detection models ane cumenty the easiest to sse, due to the standartisation of ground-ruth data in COCO tomat [16] and the avalabilty of general tramewcorks such as detectron2 [17)., Purhemore, beseline numbers in PubLayNet and DocBank wene obtained using standand object detection models such as Mask R-CNN and Fater R-CNN. As such, we wil rolato to these object detection methods in this

Figure S: Prediction perfomance (nAP@0.5-0.9G) of a Mask R-CNN neteork with ResNet50 bacibone trained on increasing fractions of with simlar data will not yield significantly better predictions.

paper and leove the detaled eveluation of more reoont methods mentioned in Secton 2 for future work.

PutLayet, we will evaluate the qualy of their predidtiors using mean average preciasion (mA) wth 10 overlaps thuat nange from 0.5 to 0.596 in steps of 0.05 (rAP@0.5-0.965). These soores ere oomputed by kveraging the evaluetion oode provided by the CO0O AP1 [16]. In this section, we wil present several aspects relatad to the performance of cbject detection models on DocLayfiet. Samiiarty as in

## Baselines for Object Detection

ofredundy anted pagesAs oe an obsev e varsn in b te modls i er wbut ovra bween  and Yolovda model doe vey wl and va ou-peroma humans on slected labols such as Tet Tabie and Picture This is not enirey In Table 2, we present baseline experimats (giwen in mAP) on Mask F-CNN [12], Faster Rt-CNN [11), and YOLOv5 [13]. Both training based image segmentation derived from bounding-boxes does not heip to obtain better predictions. On the other hand., the more recent and eveluation were perfommed on RGB imeges with dimensions of 1025 × 1025 pixels. For training, we only used one annotation in case 10% lower than the mAP computed trom the painwiss huran annotations on triple-annotated pages. This gives a good indication that the DocLayNet datiset posies a wrorthwhle chellenge for the research community to ciose the gap beteen human recognition and ML. surprising, as Text , Table and Pidtare ane abundant and the most visualy distindtive in a docurent.

Figure 3: Page 6 of the DocLayNet paper. If recognized, metadata such as authors are appearing first under the title. Elements recognized as page headers or footers are suppressed in Markdown to deliver uninterrupted content in reading order. Tables are inserted in reading order. The paragraph in "5. Experiments" wrapping over the column end is broken up in two and interrupted by the table.